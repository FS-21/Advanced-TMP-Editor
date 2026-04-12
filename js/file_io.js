import { state, generateId, TRANSPARENT_COLOR } from './state.js';
import { elements } from './constants.js';
import { t } from './translations.js';
import { TmpTsFile } from './tmp_format.js';
import { 
    renderCanvas, renderPalette, showEditorInterface, 
    updateCanvasSize, updateTilesList, showConfirm, 
    renderOverlay, updateExtraBtnState, updateTileProperties,
    resetFramesList
} from './ui.js';
import { pushHistory } from './history.js';
import { updateCurrentTabName } from './tabs.js';

/**
 * Initializes the application state with loaded TMP data
 */
export function loadTmpData(tmp) {
    console.time("TMP Initialization");
    
    state.tmpData = tmp;
    state.cblocks_x = tmp.header.cblocks_x;
    state.cblocks_y = tmp.header.cblocks_y;
    state.cx = tmp.header.cx;
    state.cy = tmp.header.cy;
    state.gameType = (state.cx === 48) ? 'ts' : 'ra2';
    
    // Calculate World Bounds
    state.worldBounds = TmpTsFile.computeBounds(tmp);
    
    // Create frames for each tile
    state.tiles = [];
    const numTiles = tmp.header.cblocks_x * tmp.header.cblocks_y;
    
    const mult = tmp.header.cy / 2;
    for (let i = 0; i < numTiles; i++) {
        const tile = tmp.tiles[i];
        if (!tile) {
            state.tiles.push({
                id: generateId(), width: tmp.header.cx, height: tmp.header.cy,
                data: new Uint8Array(tmp.header.cx * tmp.header.cy).fill(TRANSPARENT_COLOR),
                tileHeader: null, visible: true, itemMinX: 0, itemMinY: 0, _v: 0
            });
            continue;
        }

        const h = tile.tileHeader;
        const dx = h.x;
        const dy = h.y - h.height * mult;

        let minX = dx, minY = dy;
        let maxX = dx + tmp.header.cx, maxY = dy + tmp.header.cy;

        if (h.has_extra_data && h.cx_extra > 0 && h.cy_extra > 0) {
            const ex = h.x_extra;
            const ey = h.y_extra - h.height * mult;
            minX = Math.min(minX, ex); minY = Math.min(minY, ey);
            maxX = Math.max(maxX, ex + h.cx_extra); maxY = Math.max(maxY, ey + h.cy_extra);
        }

        const tw = maxX - minX;
        const th = maxY - minY;

        state.tiles.push({
            id: generateId(),
            width: tw,
            height: th,
            itemMinX: minX,
            itemMinY: minY,
            diamondX: dx - minX,
            diamondY: dy - minY,
            data: TmpTsFile.decodeTileDiamond(tile.data, tmp.header.cx, tmp.header.cy),
            zData: tile.zData ? TmpTsFile.decodeTileDiamond(tile.zData, tmp.header.cx, tmp.header.cy) : null,
            damagedData: tile.damagedData ? TmpTsFile.decodeTileDiamond(tile.damagedData, tmp.header.cx, tmp.header.cy) : null,
            tileHeader: { ...tile.tileHeader },
            extraImageData: tile.extraImageData,
            extraZData: tile.extraZData,
            extraX: h.has_extra_data ? h.x_extra - minX : 0,
            extraY: h.has_extra_data ? (h.y_extra - h.height * mult) - minY : 0,
            visible: true,
            _v: 0
        });
    }
    
    state.currentTileIdx = -1;
    state.tileSelection.clear();
    state.history = [];
    state.historyPtr = -1;
    state.hasChanges = false;
    
    state.selection = null;
    state.floatingSelection = null;
    state.subSelection.clear();
    state.currentTileKey = null;
    state.paletteVersion++; // Bust all thumbnail caches
    
    resetFramesList(); // Correctly empty the UI list using unified method
    
    // Set Canvas to World Dimensions
    if (state.worldBounds && state.worldBounds.hasTiles) {
        state.canvasW = Math.ceil(state.worldBounds.width);
        state.canvasH = Math.ceil(state.worldBounds.height);
    } else {
        state.canvasW = tmp.header.cx;
        state.canvasH = tmp.header.cy;
    }

    updateCanvasSize();
    
    // UI Updates
    updateTilesList(); 
    renderCanvas();
    showEditorInterface();
    
    updateExtraBtnState();
    if (typeof window.updateUIState === 'function') window.updateUIState();

    // Push initial snapshot so Ctrl+Z can always return to the loaded state
    pushHistory('all', true);
    state.savedHistoryPtr = state.historyPtr; // Mark this as the 'saved' point
    state.hasChanges = false;

    if (elements.tilesList) elements.tilesList.focus();
    console.timeEnd("TMP Initialization");
}

export function parsePaletteBuffer(buffer) {
    const palette = new Array(256).fill({r:0, g:0, b:0});

    const txt = new TextDecoder().decode(buffer);
    if (txt.startsWith("JASC-PAL")) {
        const lines = txt.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
        let pIdx = 0;
        for (let i = 3; i < lines.length && pIdx < 256; i++) {
            const parts = lines[i].split(/\s+/);
            if (parts.length >= 3) {
                const r = parseInt(parts[0]);
                const g = parseInt(parts[1]);
                const b = parseInt(parts[2]);
                if (!isNaN(r) && !isNaN(g) && !isNaN(b)) {
                    palette[pIdx] = { r, g, b };
                    pIdx++;
                }
            }
        }
        return palette;
    } 
    
    if (buffer.byteLength === 768) {
        const view = new Uint8Array(buffer);
        for (let i = 0; i < 256; i++) {
            const r = view[i * 3] * 4;     // 6-bit to 8-bit scaling
            const g = view[i * 3 + 1] * 4;
            const b = view[i * 3 + 2] * 4;
            palette[i] = { r, g, b };
        }
        return palette;
    }

    throw new Error("Unknown palette format. Expected JASC-PAL or 768-byte binary.");
}

export function parsePaletteData(buffer) {
    const pal = parsePaletteBuffer(buffer);
    for (let i = 0; i < 256; i++) {
        if (pal[i]) state.palette[i] = pal[i];
    }
    state.paletteVersion++;
}

export function syncTmpDataForSaving() {
    if (!state.tmpData || !state.tiles || state.tiles.length === 0) return;
    
    const dx = state.cx / 2;
    const dy = state.cy / 2;
    
    // Pass 1: Find grid bounds from tile coordinates
    let minGx = Infinity, maxGx = -Infinity, minGy = Infinity, maxGy = -Infinity;
    const mappedEntries = [];
    
    for (const t of state.tiles) {
        const h = t.tileHeader;
        if (!h) continue;
        const gx = Math.round((h.y / dy + h.x / dx) / 2);
        const gy = Math.round((h.y / dy - h.x / dx) / 2);
        minGx = Math.min(minGx, gx); maxGx = Math.max(maxGx, gx);
        minGy = Math.min(minGy, gy); maxGy = Math.max(maxGy, gy);
        mappedEntries.push({ tile: t, gx, gy });
    }
    
    let bx = 1;
    let by = 1;
    
    if (minGx !== Infinity) {
        bx = (maxGx - minGx + 1);
        by = (maxGy - minGy + 1);
    }
    
    // Safety check for empty projects or crazy bounds
    bx = Math.max(1, bx);
    by = Math.max(1, by);

    // Pass 2: Map tiles to slots and detect overflows (overlaps)
    const numNaturalSlots = bx * by;
    const naturalGrid = Array(numNaturalSlots).fill(null);
    const overflows = [];
    
    for (const entry of mappedEntries) {
        const lx = entry.gx - minGx;
        const ly = entry.gy - minGy;
        const slotIdx = ly * bx + lx;
        
        if (slotIdx >= 0 && slotIdx < numNaturalSlots && !naturalGrid[slotIdx]) {
            naturalGrid[slotIdx] = entry.tile;
        } else {
            // It's an overlap OR out of natural bounds
            overflows.push(entry.tile);
        }
    }
    
    // Resolve Final Grid Dimensions (Ensure enough slots for ALL tiles)
    const totalTilesCount = state.tiles.length;
    let finalBy = by;
    if (totalTilesCount > (bx * finalBy)) {
        finalBy = Math.ceil(totalTilesCount / bx);
    }
    
    const totalSlots = bx * finalBy;
    const finalTilesArray = Array(totalSlots).fill(null);
    
    // Fill Natural Grid
    for (let i = 0; i < numNaturalSlots; i++) {
        if (naturalGrid[i]) {
            finalTilesArray[i] = _buildSaveTileObject(naturalGrid[i], i);
        }
    }
    
    // Fill Overflow tiles into remaining empty slots
    let overflowTargetIdx = 0;
    for (const overflowTile of overflows) {
        // Find next empty slot
        while(overflowTargetIdx < totalSlots && finalTilesArray[overflowTargetIdx] !== null) {
            overflowTargetIdx++;
        }
        if (overflowTargetIdx < totalSlots) {
            finalTilesArray[overflowTargetIdx] = _buildSaveTileObject(overflowTile, overflowTargetIdx);
        }
    }
    
    state.tmpData.header.cblocks_x = bx;
    state.tmpData.header.cblocks_y = finalBy;
    state.cblocks_x = bx;
    state.cblocks_y = finalBy;
    state.tmpData.tiles = finalTilesArray;
    
    console.log(`%c[TMP Save:SUCCESS] ${totalTilesCount} cells saved.`, "color: #00ff9d; font-weight: bold;");
    console.log(`[TMP Save] Dimensions set to ${bx} x ${finalBy} cells.`);
    if (overflows.length > 0) {
        console.log(`%c[TMP Save] ${overflows.length} overlapping cells appended to end (to prevent data loss).`, "color: #f6ad55;");
    }
}

/** Helper to build the internal save object for a frame */
function _buildSaveTileObject(frame, slotIdx) {
    const cx = state.tmpData.header.cx;
    const cy = state.tmpData.header.cy;
    return {
        slot: slotIdx,
        cx: cx,
        cy: cy,
        tileHeader: { ...frame.tileHeader },
        imageData: frame.data ? TmpTsFile.encodeTileRectangle(frame.data, cx, cy) : (frame.imageData || null),
        zData: frame.zData ? TmpTsFile.encodeTileRectangle(frame.zData, cx, cy) : null,
        extraImageData: frame.extraImageData ? new Uint8Array(frame.extraImageData) : null,
        extraZData: frame.extraZData ? new Uint8Array(frame.extraZData) : null,
        damagedData: frame.damagedData ? TmpTsFile.encodeTileRectangle(frame.damagedData, cx, cy) : null
    };
}

export async function handleSaveTmp() {
    if (!state.tmpData) return;
    
    syncTmpDataForSaving();

    try {
        const buffer = TmpTsFile.encode(state.tmpData);
        const blob = new Blob([buffer], { type: 'application/octet-stream' });
        
        // Check state-specific fileHandle instead of global window variable
        if (state.fileHandle && window.showSaveFilePicker) {
            try {
                // Ensure handle still has permission (some browsers expire it)
                const writable = await state.fileHandle.createWritable();
                await writable.write(blob);
                await writable.close();
                state.savedHistoryPtr = state.historyPtr; // Update saved point
                state.hasChanges = false;
                if (window.renderTabs) window.renderTabs();
            } catch (err) {
                // If direct write fails (e.g. permission revoked), fallback to Save As
                console.warn("[Save:Direct] Failed, falling back to Save As:", err);
                await handleExportTmpAction(blob);
                state.savedHistoryPtr = state.historyPtr; 
                state.hasChanges = false;
                if (window.renderTabs) window.renderTabs();
            }
        } else {
            await handleExportTmpAction(blob);
            state.savedHistoryPtr = state.historyPtr;
            state.hasChanges = false;
            if (window.renderTabs) window.renderTabs();
        }
    } catch (err) {
        console.error("Save failed:", err);
        alert(t('msg_err_save_tmp').replace('{{error}}', err.message));
    }
}

export function showExportDialog() {
    if (elements.exportTmpDialog) {
        if (state.tmpData && state.tmpData.filename) {
            const txt = elements.txtExpTmpName;
            if (txt) txt.value = state.tmpData.filename;
        }
        elements.exportTmpDialog.showModal();
    }
}

export function initExportTmp() {
    if (elements.btnConfirmExpTmp) {
        elements.btnConfirmExpTmp.onclick = () => {
            handleExportTmp();
        };
    }
    if (elements.btnCancelExpTmp) {
        elements.btnCancelExpTmp.onclick = () => {
            if (elements.exportTmpDialog) elements.exportTmpDialog.close();
        };
    }
}

export async function handleExportTmp() {
    console.log("[Save:Entry] handleExportTmp triggered.");
    if (!state.tmpData) {
        console.error("[Save:Error] handleExportTmp: No data found.");
        return;
    }
    
    // We basically do a "Save As"
    await handleSaveTmpForceNew();
}

async function handleSaveTmpForceNew() {
    console.log("[Save:Flow] handleSaveTmpForceNew triggered.");
    if (!state.tmpData) {
        console.error("[Save:Error] state.tmpData is null!");
        alert(t('msg_err_critical_null'));
        return;
    }
    
    console.log("[Save:Flow] Syncing data...");
    syncTmpDataForSaving();

    try {
        console.log("[Save:Flow] Encoding buffer...");
        const buffer = TmpTsFile.encode(state.tmpData);
        console.log(`[Save:Flow] Buffer generated success: ${buffer.byteLength} bytes.`);
        
        const blob = new Blob([buffer], { type: 'application/octet-stream' });
        console.log("[Save:Flow] Opening File Picker...");
        await handleExportTmpAction(blob);
        console.log("[Save:Flow] All tasks completed.");
    } catch (err) {
        console.error("Export failed:", err);
        alert(t('msg_err_export_tmp').replace('{{error}}', err.message));
    }
}

async function handleExportTmpAction(blob) {
    if (window.showSaveFilePicker) {
        try {
            const handle = await window.showSaveFilePicker({
                suggestedName: state.tmpData.filename || 'output.tmp',
                types: [
                    { description: 'Temperate (TEM)', accept: { 'application/x-wwn-tmp': ['.tem'] } },
                    { description: 'Snow (SNO)', accept: { 'application/x-wwn-tmp': ['.sno'] } },
                    { description: 'Urban (URB)', accept: { 'application/x-wwn-tmp': ['.urb'] } },
                    { description: 'Desert (DES)', accept: { 'application/x-wwn-tmp': ['.des'] } },
                    { description: 'Lunar (LUN)', accept: { 'application/x-wwn-tmp': ['.lun'] } },
                    { description: 'New Urban (UBN)', accept: { 'application/x-wwn-tmp': ['.ubn'] } },
                    { description: 'All Westwood TMPs', accept: { 'application/x-wwn-tmp': ['.tem', '.sno', '.urb', '.des', '.lun', '.ubn'] } }
                ]
            });
            const writable = await handle.createWritable();
            await writable.write(blob);
            await writable.close();
            
            // Store handle correctly in state (per tab) 
            state.fileHandle = handle;
            
            state.tmpData.filename = handle.name;
            updateCurrentTabName(handle.name);
        } catch (err) {
            if (err.name !== 'AbortError') throw err;
        }
    } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = state.tmpData.filename || 'output.tmp';
        a.click();
        URL.revokeObjectURL(url);
    }
}

export async function handleClipboardPaste(imageFile) {
    // TMP clipboard paste is complex due to diamond shape
    // For now, we'll just log it or implement a simple "paste into current tile"
    console.log("Clipboard paste not yet implemented for TMP isometric tiles.");
}
