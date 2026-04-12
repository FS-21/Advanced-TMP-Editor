import { state } from './state.js';
import { elements } from './constants.js';

let hook_renderCanvas, hook_updateTilesList, hook_startAnts, hook_stopAnts, hook_updateUIState, hook_updateTileProperties, hook_updateTileDataTable, hook_updateCanvasSize, hook_recomputeWorldBoundsFromState;

export function initHistoryHooks(renderCanvasFn, updateTilesListFn, startAntsFn, stopAntsFn, updateUIStateFn, updateTilePropertiesFn, updateTileDataTableFn, updateCanvasSizeFn, recomputeWorldBoundsFromStateFn) {
    hook_renderCanvas = renderCanvasFn;
    hook_updateTilesList = updateTilesListFn;
    hook_startAnts = startAntsFn;
    hook_stopAnts = stopAntsFn;
    hook_updateUIState = updateUIStateFn;
    hook_updateTileProperties = updateTilePropertiesFn;
    hook_updateTileDataTable = updateTileDataTableFn;
    hook_updateCanvasSize = updateCanvasSizeFn;
    hook_recomputeWorldBoundsFromState = recomputeWorldBoundsFromStateFn;
}

export function renderHistory() {
    if (!elements.historyList) return;
    elements.historyList.innerHTML = '';
    state.history.forEach((h, i) => {
        const el = document.createElement('div');
        el.style.padding = "4px";
        el.style.cursor = "pointer";
        el.style.borderBottom = "1px solid #333";
        el.style.fontSize = "12px";
        el.innerText = `Action ${i + 1}`;
        if (i === state.historyPtr) {
            el.style.backgroundColor = "#094771";
            el.style.color = "#fff";
        } else {
            el.style.color = "#888";
        }

        el.onclick = () => {
            if (i === state.historyPtr) return;
            state.historyPtr = i;
            restoreHistory(state.history[i]);
        };
        elements.historyList.appendChild(el);
    });
    elements.historyList.scrollTop = elements.historyList.scrollHeight;
}

/**
 * Deep clones a layer/group node recursively.
 */
export function cloneLayerNode(node) {
    if (!node) return null;
    const cloned = {
        id: node.id,
        name: node.name,
        type: node.type || 'layer',
        visible: node.visible !== undefined ? node.visible : true,
        width: node.width,
        height: node.height,
        clipped: !!node.clipped,
        expanded: !!node.expanded,
        isMask: !!node.isMask,
        maskType: node.maskType || 'alpha',
        ghosting: !!node.ghosting,
        ghostOpacity: node.ghostOpacity !== undefined ? node.ghostOpacity : 50,
        x: node.x || 0,
        y: node.y || 0,
        _v: node._v || 0
    };

    if (node.type === 'external_shp') {
        cloned.extWidth = node.extWidth;
        cloned.extHeight = node.extHeight;
        cloned.extFrameX = node.extFrameX;
        cloned.extFrameY = node.extFrameY;
        cloned.extTmpWidth = node.extTmpWidth;
        cloned.extTmpHeight = node.extTmpHeight;
        cloned.extFilename = node.extFilename;

        if (node.extTmpFrameData) {
            cloned.extTmpFrameData = new Uint8Array(node.extTmpFrameData);
        }
        if (node.extTmpPalette) {
            cloned.extTmpPalette = JSON.parse(JSON.stringify(node.extTmpPalette));
        }
    }

    if (node.data) {
        // High Performance Copy for Typed Arrays
        if (node.data instanceof Uint8Array || node.data instanceof Uint8Array) {
            cloned.data = new node.data.constructor(node.data);
        } else {
            cloned.data = node.data.slice();
        }
    }
    if (node.mask) {
        cloned.mask = new Uint8Array(node.mask);
    }
    if (node.layers) {
        cloned.layers = node.layers.map(c => cloneLayerNode(c));
    }
    if (node.children) {
        cloned.children = node.children.map(c => cloneLayerNode(c));
    }

    return cloned;
}

export function pushHistory(modifiedFrameIndices = null, isInitial = false) {
    if (state.historyPtr < state.history.length - 1) {
        state.history = state.history.slice(0, state.historyPtr + 1);
    }
    
    if (hook_recomputeWorldBoundsFromState) hook_recomputeWorldBoundsFromState();

    // Determine which frames to clone
    let framesToClone = new Set();
    if (state._isRestoringHistory) return;

    if (modifiedFrameIndices === 'all') {
        state.tiles.forEach((_, i) => framesToClone.add(i));
    } else if (modifiedFrameIndices === 'reorder') {
        // Do not add any frames to clone - just structural reorder
    } else if (modifiedFrameIndices !== null) {
        if (Array.isArray(modifiedFrameIndices)) {
            modifiedFrameIndices.forEach(idx => framesToClone.add(idx));
        } else if (typeof modifiedFrameIndices === 'number') {
            framesToClone.add(modifiedFrameIndices);
        }
    } else {
        if (state.tileSelection && state.tileSelection.size > 0) {
            state.tileSelection.forEach(idx => framesToClone.add(idx));
        } else if (state.currentTileIdx >= 0 && state.currentTileIdx < state.tiles.length) {
            framesToClone.add(state.currentTileIdx);
        }
    }

    // Increment version for ALL frames being cloned to ensure thumbnails definitely refresh
    if (framesToClone.size > 0) {
        console.log(`[History] Pushing to history. Cloning frames: ${Array.from(framesToClone).join(', ')}`);
    } else {
        console.log(`[History] Pushing to history. Structural change or selection only (no pixel cloning).`);
    }

    framesToClone.forEach(idx => {
        if (state.tiles[idx]) {
            state.tiles[idx]._v = (state.tiles[idx]._v || 0) + 1;
        }
    });

    // Special case for selection-only history points
    const isSelectionOnly = modifiedFrameIndices !== null &&
        Array.isArray(modifiedFrameIndices) &&
        modifiedFrameIndices.length === 0;

    const prevSnapshot = state.historyPtr >= 0 ? state.history[state.historyPtr] : null;

    // Optimization: Skip if no change vs previous state (to avoid duplicate selection points)
    if (prevSnapshot && isSelectionOnly) {
        const prevSel = prevSnapshot.tileSelection;
        const currSel = state.tileSelection;
        const prevSub = prevSnapshot.subSelection;
        const currSub = state.subSelection;

        // Same currentTile, same tileSelection size and members, same subSelection
        const selectionUnchanged = prevSnapshot.currentTileIdx === state.currentTileIdx &&
            prevSel && currSel && prevSel.size === currSel.size &&
            [...currSel].every(v => prevSel.has(v)) &&
            prevSub && currSub && prevSub.size === currSub.size &&
            [...currSub].every(v => prevSub.has(v));

        if (selectionUnchanged) return;
    }

    let framesSnapshot;
    // For selection-only history points, reuse the entire frames array from the previous snapshot
    // since no pixel data has changed — just the active frame/layer changed
    if (isSelectionOnly && prevSnapshot && prevSnapshot.frames.length === state.tiles.length) {
        // FAST PATH: selection only, we trust the frames are the same (no deletions or additions happened)
        framesSnapshot = prevSnapshot.frames;
    } else {
        // Ensure all live frames have unique IDs for tracking across reorders
        // ONLY if we are actually creating a new snapshot that might involve reorders or cloning
        state.tiles.forEach(f => {
            if (!f.id) f.id = Math.random().toString(36).substr(2, 9);
        });

        // Build a lookup map from previous snapshot for O(1) access by frame ID
        let prevFrameMap = null;
        if (prevSnapshot) {
            prevFrameMap = new Map();
            prevSnapshot.frames.forEach((pf, idx) => {
                if (pf.id) prevFrameMap.set(pf.id, pf);
            });
        }

        framesSnapshot = state.tiles.map((f, i) => {
            let prevFrame = null;
            if (prevFrameMap) {
                prevFrame = prevFrameMap.get(f.id) || null;
            }

            if (framesToClone.size === state.tiles.length || !prevFrame || prevFrame._v !== f._v) {
                // If we are cloning ALL frames (initial or mass edit), or if no prior snapshot exists, or if frame has been mutated since the last snapshot (dirty check)
                const clone = {
                    id: f.id,
                    width: f.width,
                    height: f.height,
                    cx: f.cx,
                    cy: f.cy,
                    duration: f.duration,
                    lastSelectedIdx: f.lastSelectedIdx,
                    _v: f._v,
                    visible: f.visible !== undefined ? f.visible : true,
                    data: f.data ? new Uint8Array(f.data) : null,
                    layers: f.layers ? f.layers.map(l => cloneLayerNode(l)) : [],
                    // TMP Specific Fields
                    tileHeader: f.tileHeader ? JSON.parse(JSON.stringify(f.tileHeader)) : null,
                    extraImageData: f.extraImageData ? new Uint8Array(f.extraImageData) : null,
                    zData: f.zData ? new Uint8Array(f.zData) : null,
                    extraZData: f.extraZData ? new Uint8Array(f.extraZData) : null,
                    damagedData: f.damagedData ? new Uint8Array(f.damagedData) : null,
                    itemMinX: f.itemMinX,
                    itemMinY: f.itemMinY,
                    diamondX: f.diamondX,
                    diamondY: f.diamondY,
                    extraX: f.extraX,
                    extraY: f.extraY,
                    _extraImg_cx: f._extraImg_cx,
                    _extraImg_cy: f._extraImg_cy,
                    _extraZ_cx: f._extraZ_cx,
                    _extraZ_cy: f._extraZ_cy
                };
                return clone;
            } else if (framesToClone.has(i)) {
                 // Clone only this specific frame
                 const clone = {
                    id: f.id,
                    width: f.width,
                    height: f.height,
                    cx: f.cx,
                    cy: f.cy,
                    duration: f.duration,
                    lastSelectedIdx: f.lastSelectedIdx,
                    _v: f._v,
                    visible: f.visible !== undefined ? f.visible : true,
                    data: f.data ? new Uint8Array(f.data) : null,
                    layers: f.layers ? f.layers.map(l => cloneLayerNode(l)) : [],
                    // TMP Specific Fields
                    tileHeader: f.tileHeader ? JSON.parse(JSON.stringify(f.tileHeader)) : null,
                    extraImageData: f.extraImageData ? new Uint8Array(f.extraImageData) : null,
                    zData: f.zData ? new Uint8Array(f.zData) : null,
                    extraZData: f.extraZData ? new Uint8Array(f.extraZData) : null,
                    damagedData: f.damagedData ? new Uint8Array(f.damagedData) : null,
                    itemMinX: f.itemMinX,
                    itemMinY: f.itemMinY,
                    diamondX: f.diamondX,
                    diamondY: f.diamondY,
                    extraX: f.extraX,
                    extraY: f.extraY,
                    _extraImg_cx: f._extraImg_cx,
                    _extraImg_cy: f._extraImg_cy,
                    _extraZ_cx: f._extraZ_cx,
                    _extraZ_cy: f._extraZ_cy
                };
                return clone;
            }
            // Inherit the STABLE reference from the previous history entry by ID
            return prevFrame;
        });
    }

    let selectionSnapshot = null;
    if (state.selection) {
        selectionSnapshot = { ...state.selection };
        if (state.selection.maskData) {
            selectionSnapshot.maskData = new Uint8Array(state.selection.maskData);
        }
    }

    let floatingSnapshot = null;
    if (state.floatingSelection) {
        floatingSnapshot = { ...state.floatingSelection };
        if (state.floatingSelection.data) {
            floatingSnapshot.data = state.floatingSelection.data.slice();
        }
        if (state.floatingSelection.maskData) {
            floatingSnapshot.maskData = new Uint8Array(state.floatingSelection.maskData);
        }
        if (state.floatingSelection.originalData) {
            floatingSnapshot.originalData = state.floatingSelection.originalData.slice();
        }
        if (state.floatingSelection.originalMaskData) {
            floatingSnapshot.originalMaskData = new Uint8Array(state.floatingSelection.originalMaskData);
        }
    }

    state.history.push({
        frames: framesSnapshot,
        selection: selectionSnapshot,
        floatingSelection: floatingSnapshot,
        canvasW: state.canvasW,
        canvasH: state.canvasH,
        activeLayerId: state.activeLayerId,
        currentTileIdx: state.currentTileIdx,
        tileSelection: new Set(state.tileSelection),
        subSelection: new Set(state.subSelection),
        currentTileKey: state.currentTileKey,
        // Global Project State
        cx: state.cx,
        cy: state.cy,
        gameType: state.gameType,
        cblocks_x: state.cblocks_x,
        cblocks_y: state.cblocks_y,
        palette: JSON.parse(JSON.stringify(state.palette))
    });

    // Dynamic history limit based on project size to prevent excessive memory usage
    const projectSize = state.tiles.length * state.canvasW * state.canvasH;
    let historyLimit;

    if (projectSize > 500000000) {
        historyLimit = 20;
    } else if (projectSize > 200000000) {
        historyLimit = 50;
    } else if (projectSize > 50000000) {
        historyLimit = 100;
    } else {
        historyLimit = 200;
    }

    if (historyLimit < 100 && !state.historyLimitNotified) {
        state.historyLimitNotified = true;
        console.warn(`History limit reduced to ${historyLimit} entries due to large project size (${state.tiles.length} frames, ${state.canvasW}x${state.canvasH})`);
    }

    if (state.history.length > historyLimit) {
        state.history.shift();
    } else {
        state.historyPtr++;
    }

    // Update "hasChanges" and Tab visual state
    const wasChanged = state.hasChanges;
    state.hasChanges = (state.historyPtr !== state.savedHistoryPtr);
    
    if (wasChanged !== state.hasChanges) {
        if (window.renderTabs) window.renderTabs();
    }

    renderHistory();
    if (hook_updateUIState) hook_updateUIState(state.tiles.length > 0);
}


export function undo() {
    console.log("DEBUG: Undo triggered, ptr:", state.historyPtr);
    if (state.historyPtr > 0) {
        state.historyPtr--;
        restoreHistory(state.history[state.historyPtr]);
        
        // Update dirty flag
        state.hasChanges = (state.historyPtr !== state.savedHistoryPtr);
        if (window.renderTabs) window.renderTabs();
        
        if (hook_updateUIState) hook_updateUIState();
    }
}

export function redo() {
    console.log("DEBUG: Redo triggered, ptr:", state.historyPtr, "of", state.history.length);
    if (state.historyPtr < state.history.length - 1) {
        state.historyPtr++;
        restoreHistory(state.history[state.historyPtr]);
        
        // Update dirty flag
        state.hasChanges = (state.historyPtr !== state.savedHistoryPtr);
        if (window.renderTabs) window.renderTabs();
        
        if (hook_updateUIState) hook_updateUIState();
    }
}

export function restoreHistory(snapshot) {
    if (!snapshot) return;

    state._isRestoringHistory = true;
    try {
        console.log(`[History] Restoring snapshot. Frames: ${snapshot.frames.length}, Canvas: ${snapshot.canvasW}x${snapshot.canvasH}`);

    // Handle both old (array of frames) and new formats
    const isNewFormat = snapshot && !Array.isArray(snapshot) && snapshot.frames;
    const frames = isNewFormat ? snapshot.frames : snapshot;

    // Ensure we don't accidentally mutate history objects when restoring
    // FIX: Must deep clone ALL frames, otherwise Snapshot objects can be mutated by live state
    state.tiles = frames.map((f, i) => {
        return {
            id: f.id,
            width: f.width,
            height: f.height,
            cx: f.cx,
            cy: f.cy,
            duration: f.duration,
            lastSelectedIdx: f.lastSelectedIdx,
            _v: f._v,
            visible: f.visible !== undefined ? f.visible : true,
            data: f.data ? new Uint8Array(f.data) : null,
            layers: f.layers ? f.layers.map(l => cloneLayerNode(l)) : [],
            // TMP Specific Restoration
            tileHeader: f.tileHeader ? { ...f.tileHeader } : null,
            extraImageData: f.extraImageData ? new Uint8Array(f.extraImageData) : null,
            zData: f.zData ? new Uint8Array(f.zData) : null,
            extraZData: f.extraZData ? new Uint8Array(f.extraZData) : null,
            damagedData: f.damagedData ? new Uint8Array(f.damagedData) : null,
            itemMinX: f.itemMinX,
            itemMinY: f.itemMinY,
            diamondX: f.diamondX,
            diamondY: f.diamondY,
            extraX: f.extraX,
            extraY: f.extraY,
            _extraImg_cx: f._extraImg_cx,
            _extraImg_cy: f._extraImg_cy,
            _extraZ_cx: f._extraZ_cx,
            _extraZ_cy: f._extraZ_cy
        };
    });

    if (isNewFormat) {
        if (snapshot.selection) {
            state.selection = { ...snapshot.selection };
            if (snapshot.selection.maskData) {
                state.selection.maskData = new Uint8Array(snapshot.selection.maskData);
            }
        } else {
            state.selection = null;
        }

        if (snapshot.floatingSelection) {
            state.floatingSelection = { ...snapshot.floatingSelection };
            if (snapshot.floatingSelection.data) {
                state.floatingSelection.data = new Uint8Array(snapshot.floatingSelection.data);
            }
            if (snapshot.floatingSelection.maskData) {
                state.floatingSelection.maskData = new Uint8Array(snapshot.floatingSelection.maskData);
            }
            if (snapshot.floatingSelection.originalData) {
                state.floatingSelection.originalData = new Uint8Array(snapshot.floatingSelection.originalData);
            }
            if (snapshot.floatingSelection.originalMaskData) {
                state.floatingSelection.originalMaskData = new Uint8Array(snapshot.floatingSelection.originalMaskData);
            }
        } else {
            state.floatingSelection = null;
        }

        if (snapshot.canvasW !== undefined) state.canvasW = snapshot.canvasW;
        if (snapshot.canvasH !== undefined) state.canvasH = snapshot.canvasH;
        if (snapshot.activeLayerId !== undefined) state.activeLayerId = snapshot.activeLayerId;
        if (snapshot.currentTileIdx !== undefined) state.currentTileIdx = snapshot.currentTileIdx;

        // Restore tile selection
        if (snapshot.tileSelection) {
            state.tileSelection = new Set(snapshot.tileSelection);
        } else {
            state.tileSelection = new Set();
        }
        if (snapshot.subSelection) {
            state.subSelection = new Set(snapshot.subSelection);
        } else {
            state.subSelection = new Set();
        }
        if (snapshot.currentTileKey !== undefined) {
            state.currentTileKey = snapshot.currentTileKey;
        }

        // Restore global project state
        if (snapshot.cx !== undefined) state.cx = snapshot.cx;
        if (snapshot.cy !== undefined) state.cy = snapshot.cy;
        if (snapshot.gameType !== undefined) state.gameType = snapshot.gameType;
        if (snapshot.cblocks_x !== undefined) state.cblocks_x = snapshot.cblocks_x;
        if (snapshot.cblocks_y !== undefined) state.cblocks_y = snapshot.cblocks_y;
        if (snapshot.palette !== undefined) {
            state.palette = JSON.parse(JSON.stringify(snapshot.palette));
            state.paletteVersion++;
        }

    } else {
        state.floatingSelection = null;
        state.selection = null;
    }

        if (hook_updateCanvasSize) hook_updateCanvasSize();
        if (hook_recomputeWorldBoundsFromState) hook_recomputeWorldBoundsFromState();

        if (state.currentTileIdx >= state.tiles.length) state.currentTileIdx = 0;

        if (state.selection) {
            if (hook_startAnts) hook_startAnts();
        } else {
            if (hook_stopAnts) hook_stopAnts();
        }

        // Reset overlap cache
        if (state.overlappingTiles) state.overlappingTiles.clear();

        if (hook_renderCanvas) hook_renderCanvas();
        if (hook_updateTilesList) hook_updateTilesList();
        if (hook_updateTileProperties) hook_updateTileProperties();
        if (hook_updateTileDataTable) hook_updateTileDataTable();
        renderHistory();
        if (hook_updateUIState) hook_updateUIState(state.tiles.length > 0);
    } finally {
        state._isRestoringHistory = false;
        console.log("[History] Restore complete. UI refreshed.");
    }
}
