import { state, activeTool, setActiveTool, isDrawing, setIsDrawing, lastPos, setLastPos, TRANSPARENT_COLOR } from './state.js';
import { elements } from './constants.js';
import { renderCanvas, renderOverlay, setColor, updateToolSettingsUI, getActiveLayer, triggerSelectionFlash, commitSelection, clearSelection, combineSelection, updateTilesList, getLayerDataSnapshot } from './ui.js';
import { pushHistory } from './history.js';
import { bresenham } from './utils.js';
import { openNewTmpDialog, updateUIState } from './main.js';
export function setTool(t) {
    const selectionRelatedTools = ['select', 'lasso', 'wand', 'movePixels', 'moveSelectionArea'];
    const isNewToolSelectionRelated = selectionRelatedTools.includes(t);

    setActiveTool(t); // Always set, no toggle

    // Auto-close extra side panel when selecting any tool
    if (t && state.showSidePanel) {
        state.showSidePanel = false;
        if (elements.sidePanelExtra) elements.sidePanelExtra.classList.add('collapsed');
    }

    // Commit any floating selection when changing tools (except if new tool is movePixels)
    if (state.floatingSelection && t !== 'movePixels') {
        if (isNewToolSelectionRelated) {
            commitSelection(); // Merge pixels, keep area
        } else {
            clearSelection(); // Merge pixels, clear area
        }
    } else if (!isNewToolSelectionRelated && t !== null) {
        // Selection persists even if the tool is not selection-related
        renderOverlay();
    }

    // Manage tool button active state if they follow the pattern
    document.querySelectorAll('.tool-btn').forEach(b => {
        if (b === elements.btnToggleSidePanel) return;
        b.classList.remove('active');
        if (b.dataset.tool === t) b.classList.add('active');
    });

    updateToolSettingsUI(t);

    const current = activeTool;
    if (!current) {
        renderCanvas();
        renderOverlay(undefined, undefined, null, lastPos);
        return;
    }

    updateCanvasCursor(false);

    renderCanvas();
    renderOverlay(undefined, undefined, current, lastPos);

    if (elements.mainCanvas) elements.mainCanvas.focus();
}

/**
 * Centralized cursor management.
 * @param {boolean} isOverSelection - Whether the mouse is currently over an active selection mask.
 */
export function updateCanvasCursor(isOverSelection, forceCursor = null) {
    const current = activeTool;
    const moveTools = ['movePixels', 'moveSelectionArea'];

    let cursor = 'default';

    if (forceCursor) {
        cursor = forceCursor;
    } else if (isOverSelection && moveTools.includes(current)) {
        cursor = 'move';
    } else if (current === 'picker') {
        // Custom crosshair with hollow center for picker
        const crosshairSvg = `<svg xmlns='http://www.w3.org/2000/svg' width='15' height='15' viewBox='0 0 15 15'><path d='M7 0v6M7 9v6M0 7h6M9 7h6' stroke='white' stroke-width='1.5'/><path d='M7 0v6M7 9v6M0 7h6M9 7h6' stroke='black' stroke-width='0.5'/></svg>`;
        cursor = `url("data:image/svg+xml,${encodeURIComponent(crosshairSvg)}") 7 7, crosshair`;
    } else if (['select', 'lasso', 'wand'].includes(current)) {
        cursor = 'crosshair';
    } else if (moveTools.includes(current)) {
        cursor = 'move';
    }

    if (lastCursor !== cursor) {
        elements.mainCanvas.style.cursor = cursor;
        elements.overlayCanvas.style.cursor = cursor;
        lastCursor = cursor;
    }
}

let lastCursor = '';



export function getSelectionHandleAt(x, y, sel, z) {
    if (!sel) return null;
    const handleSize = 6;
    const threshold = (handleSize / 2 + 2) / z;

    const sx = sel.x;
    const sy = sel.y;
    const sw = sel.w;
    const sh = sel.h;

    const positions = [
        [sx, sy], [sx + sw / 2, sy], [sx + sw, sy], // 0, 1, 2
        [sx, sy + sh / 2], [sx + sw, sy + sh / 2], // 3, 4
        [sx, sy + sh], [sx + sw / 2, sy + sh], [sx + sw, sy + sh] // 5, 6, 7
    ];

    for (let i = 0; i < positions.length; i++) {
        const [px, py] = positions[i];
        if (Math.abs(x - px) <= threshold && Math.abs(y - py) <= threshold) {
            return i;
        }
    }
    return null;
}

export function handleToCursor(idx) {
    const cursors = ['nwse-resize', 'ns-resize', 'nesw-resize', 'ew-resize', 'ew-resize', 'nesw-resize', 'ns-resize', 'nwse-resize'];
    return cursors[idx] || 'default';
}

/**
 * Helper to check if a pixel coordinate is within the active selection.
 */
export function isPixelInSelection(x, y) {
    if (!state.selection) return true;
    const sel = state.selection;
    if (sel.type === 'rect') {
        return x >= sel.x && x < sel.x + sel.w &&
            y >= sel.y && y < sel.y + sel.h;
    }
    return true;
}

export function pickColor(x, y, isMultiSelect = false) {
    const layer = getActiveLayer();
    if (!layer || !layer.data) return -1;

    const lw = layer.width || state.canvasW;
    const lh = layer.height || state.canvasH;
    
    let lx = layer.x || 0;
    let ly = layer.y || 0;

    if (layer.tileHeader && state.worldBounds) {
        const mult = state.cy / 2;
        lx = Math.round(layer.tileHeader.x - state.worldBounds.minX);
        ly = Math.round((layer.tileHeader.y - layer.tileHeader.height * mult) - state.worldBounds.minY);
    }

    const localX = Math.floor(x - lx);
    const localY = Math.floor(y - ly);

    if (localX < 0 || localX >= lw || localY < 0 || localY >= lh) return -1;

    const idx = layer.data[localY * lw + localX];

    // Ignore void pixels (65535), keep everything else (0-255)
    if (idx === TRANSPARENT_COLOR) return -1;

    // Success
    if (!isMultiSelect) {
        state.paletteSelection.clear();
    }
    state.paletteSelection.add(idx);
    state.lastPaletteIdx = idx;

    setColor(idx);
    return idx;
}

export function deleteSelection() {
    if (!state.selection) return;
    const tile = getActiveLayer();
    if (!tile || !tile.visible) return;

    const sel = state.selection;
    const minX = state.worldBounds.minX;
    const minY = state.worldBounds.minY;

    // Relative to the Project top-left baseline
    const lxOffset = Math.round(tile.itemMinX - minX);
    const lyOffset = Math.round(tile.itemMinY - minY);

    for (let y = sel.y; y < sel.y + sel.h; y++) {
        for (let x = sel.x; x < sel.x + sel.w; x++) {
            // Mask transparency check if applicable
            if (sel.type === 'mask' && !sel.maskData[(y - sel.y) * sel.w + (x - sel.x)]) continue;

            // Project coordinate to local tile bounds
            const locX = x - lxOffset;
            const locY = y - lyOffset;

            // 1. Diamond Base Fragment
            const bDx = Math.round(locX - tile.diamondX);
            const bDy = Math.round(locY - tile.diamondY);
            if (bDx >= 0 && bDx < state.cx && bDy >= 0 && bDy < state.cy) {
                tile.data[bDy * state.cx + bDx] = TRANSPARENT_COLOR;
            }

            // 2. Extra Data Fragment
            if (tile.tileHeader && tile.tileHeader.has_extra_data && tile.extraImageData) {
                const exX = Math.round(locX - tile.extraX);
                const exY = Math.round(locY - tile.extraY);
                if (exX >= 0 && exX < tile.tileHeader.cx_extra && exY >= 0 && exY < tile.tileHeader.cy_extra) {
                    tile.extraImageData[exY * tile.tileHeader.cx_extra + exX] = 0;
                }
            }
        }
    }

    tile._v = (tile._v || 0) + 1;
    pushHistory();
    renderCanvas();
    updateTilesList();
    if (typeof renderOverlay === 'function') renderOverlay();
}

export function getPos(e) {
    const rect = elements.mainCanvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / state.zoom);
    const y = Math.floor((e.clientY - rect.top) / state.zoom);
    return { x, y };
}




export function deselect() {
    if (state.selection) {
        clearSelection();
        renderCanvas();
        renderOverlay();
        if (typeof updateUIState === 'function') updateUIState();
    }
}

export function cropToSelection() {
    if (!state.selection && !state.floatingSelection) return;

    const fs = state.floatingSelection;
    const sel = state.selection;
    const cropX = sel ? sel.x : fs.x;
    const cropY = sel ? sel.y : fs.y;
    const cropW = sel ? sel.w : fs.w;
    const cropH = sel ? sel.h : fs.h;

    // Resize state
    state.canvasW = cropW;
    state.canvasH = cropH;

    // Process all frames and layers
    state.tiles.forEach((frame, fIdx) => {
        frame.width = cropW;
        frame.height = cropH;

        const layers = frame.layers || [frame];
        layers.forEach(layer => {
            if (layer.type === 'group' || layer.type === 'external_shp') return;

            const oldData = layer.data;
            if (!oldData) return;
            const newData = new Uint8Array(cropW * cropH);
            newData.fill(TRANSPARENT_COLOR);
            const oldW = layer.width;
            const oldH = layer.height;

            // Copy logic
            for (let y = 0; y < cropH; y++) {
                for (let x = 0; x < cropW; x++) {
                    const srcX = cropX + x;
                    const srcY = cropY + y;

                    if (srcX >= 0 && srcX < oldW && srcY >= 0 && srcY < oldH) {
                        const oldIdx = oldData[srcY * oldW + srcX];

                        // If this is the active layer, check if pixel was inside selection mask
                        if (layer.id === state.activeLayerId || layers.length === 1) {
                            let isInMask = true;
                            if (sel && sel.type === 'mask' && sel.maskData) {
                                if (!sel.maskData[y * cropW + x]) isInMask = false;
                            }

                            if (isInMask) {
                                newData[y * cropW + x] = oldIdx;
                            } else {
                                newData[y * cropW + x] = TRANSPARENT_COLOR;
                            }
                        } else {
                            // Other layers: Just crop (preserve content)
                            newData[y * cropW + x] = oldIdx;
                        }
                    }
                }
            }

            // If this is the active layer and we have a floating selection, merge it directly into newData!
            if (fs && fIdx === fs.frameIdx && (layer.id === fs.targetLayerId || layers.length === 1)) {
                for (let fy = 0; fy < fs.h; fy++) {
                    for (let fx = 0; fx < fs.w; fx++) {
                        if (fs.maskData && !fs.maskData[fy * fs.w + fx]) continue;

                        const val = fs.data[fy * fs.w + fx];
                        if (val !== TRANSPARENT_COLOR) {
                            const nx = (fs.x + fx) - cropX;
                            const ny = (fs.y + fy) - cropY;
                            if (nx >= 0 && nx < cropW && ny >= 0 && ny < cropH) {
                                newData[ny * cropW + nx] = val;
                            }
                        }
                    }
                }
            }

            layer.data = newData;
            layer.width = cropW;
            layer.height = cropH;
            layer._v = (layer._v || 0) + 1;
        });
    });

    state.selection = null;
    state.floatingSelection = null;
    state.isSelecting = false;
    state.isMovingSelection = false;

    pushHistory('all');
    updateCanvasSize();
    updateTilesList();
    updateTilesList();
    renderCanvas();
    renderOverlay();
}

export function fillSelection() {
    if (!state.selection) return;
    const layer = getActiveLayer();
    if (!layer || !layer.visible) return;

    const sel = state.selection;
    const colorIdx = state.primaryColorIdx;
    const w = state.canvasW;
    const h = state.canvasH;

    if (sel.type === 'rect') {
        for (let y = sel.y; y < sel.y + sel.h; y++) {
            for (let x = sel.x; x < sel.x + sel.w; x++) {
                if (x >= 0 && x < w && y >= 0 && y < h) {
                    layer.data[y * w + x] = colorIdx;
                }
            }
        }
    } else if (sel.type === 'mask') {
        for (let y = 0; y < sel.h; y++) {
            for (let x = 0; x < sel.w; x++) {
                if (sel.maskData[y * sel.w + x]) {
                    const tx = sel.x + x;
                    const ty = sel.y + y;
                    if (tx >= 0 && tx < w && ty >= 0 && ty < h) {
                        layer.data[ty * w + tx] = colorIdx;
                    }
                }
            }
        }
    }
    layer._v = (layer._v || 0) + 1;
    pushHistory();
    renderCanvas();
    renderOverlay();
}


