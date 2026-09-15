import { state, generateId, TRANSPARENT_COLOR } from './state.js';
import { elements } from './constants.js';
import { t } from './translations.js';
import { TmpTsFile } from './tmp_format.js';
import { 
    renderCanvas, renderPalette, showEditorInterface, 
    updateCanvasSize, updateTilesList, showConfirm, 
    renderOverlay, updateExtraBtnState, updateTileProperties,
    resetFramesList, showPasteNotification
} from './ui.js';
import { pushHistory, resetHistoryForFreshOpen } from './history.js';
import { updateCurrentTabName } from './tabs.js';
import { applyPaletteById, getActivePaletteId } from './palette_menu.js';

/**
 * Initializes the application state with loaded TMP data
 */
export function loadTmpData(tmp, filename = '', skipPaletteAutoselect = false) {
    console.time("TMP Initialization");
    
    state.tmpData = tmp;
    if (filename) {
        state.tmpData.filename = filename;
    }
    state.cblocks_x = tmp.header.cblocks_x;
    state.cblocks_y = tmp.header.cblocks_y;
    state.cx = tmp.header.cx;
    state.cy = tmp.header.cy;
    state.gameType = (state.cx === 48) ? 'ts' : 'ra2';
    
    // Autoselect palette if not manually selected by the user
    if (!state.paletteSelectedManually && filename && !skipPaletteAutoselect) {
        const ext = filename.split('.').pop().toLowerCase();
        let autoPaletteId = null;

        if (state.cx === 48) {
            if (ext === 'sno') {
                autoPaletteId = 'game_ts_isosno';
            } else {
                autoPaletteId = 'game_ts_isotem';
            }
        } else if (state.cx === 60) {
            if (ext === 'sno') {
                autoPaletteId = 'game_ra2_isosno';
            } else if (ext === 'tem') {
                autoPaletteId = 'game_ra2_isotem';
            } else if (ext === 'urb') {
                autoPaletteId = 'game_ra2_isourb';
            } else if (ext === 'des') {
                autoPaletteId = 'game_yr_isodes';
            } else if (ext === 'ubn') {
                autoPaletteId = 'game_yr_isoubn';
            } else if (ext === 'lun') {
                autoPaletteId = 'game_yr_isolun';
            } else {
                autoPaletteId = 'game_ra2_isotem';
            }
        }

        if (autoPaletteId) {
            applyPaletteById(autoPaletteId, false);
        }
    }
    

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
            damagedData: null,
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

    // Reset history so the freshly opened file is the only entry
    // (Ctrl+Z will not erase the file).
    resetHistoryForFreshOpen();

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
            const r6 = view[i * 3];
            const g6 = view[i * 3 + 1];
            const b6 = view[i * 3 + 2];
            palette[i] = {
                r: (r6 << 2) | (r6 >> 4),
                g: (g6 << 2) | (g6 >> 4),
                b: (b6 << 2) | (b6 >> 4)
            };
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
        damagedData: null
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

export function getSuggestedTmpFilename() {
    const curTab = (state.activeTabIndex >= 0 && state.tabs && state.tabs[state.activeTabIndex]) ? state.tabs[state.activeTabIndex] : null;
    let name = (state.tmpData && state.tmpData.filename) || (curTab && !curTab.isNewProject && curTab.fileName) || '';
    
    // Remove any accidental or redundant '.tmp' extension from the name
    if (name) {
        name = name.replace(/\.tmp(?=\.|$)/ig, '');
    }

    // If it already ends in a valid Westwood theater extension, keep it
    if (name && /\.(tem|sno|urb|des|lun|ubn)$/i.test(name)) {
        return name;
    }

    // Determine the theater extension from active palette if possible
    let ext = 'tem';
    try {
        const palId = (typeof getActivePaletteId === 'function') ? getActivePaletteId() : null;
        if (palId) {
            const lower = palId.toLowerCase();
            if (lower.includes('sno')) ext = 'sno';
            else if (lower.includes('ubn')) ext = 'ubn';
            else if (lower.includes('urb')) ext = 'urb';
            else if (lower.includes('des')) ext = 'des';
            else if (lower.includes('lun')) ext = 'lun';
            else if (lower.includes('tem')) ext = 'tem';
        }
    } catch (e) {}

    const base = name || 'output';
    return `${base}.${ext}`;
}

export function showExportDialog() {
    if (elements.exportTmpDialog) {
        const txt = elements.txtExpTmpName;
        if (txt) txt.value = getSuggestedTmpFilename();
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
    const suggestedName = getSuggestedTmpFilename();
    const ext = '.' + suggestedName.split('.').pop().toLowerCase();

    const allTypes = [
        { description: 'Temperate (TEM)', accept: { 'application/x-wwn-tmp-tem': ['.tem'] } },
        { description: 'Snow (SNO)', accept: { 'application/x-wwn-tmp-sno': ['.sno'] } },
        { description: 'Urban (URB)', accept: { 'application/x-wwn-tmp-urb': ['.urb'] } },
        { description: 'Desert (DES)', accept: { 'application/x-wwn-tmp-des': ['.des'] } },
        { description: 'Lunar (LUN)', accept: { 'application/x-wwn-tmp-lun': ['.lun'] } },
        { description: 'New Urban (UBN)', accept: { 'application/x-wwn-tmp-ubn': ['.ubn'] } },
        { description: 'All Westwood TMPs', accept: { 'application/x-wwn-tmp-all': ['.tem', '.sno', '.urb', '.des', '.lun', '.ubn'] } }
    ];
    // Put the type matching the suggested extension at the top so it is selected by default
    const matchedIdx = allTypes.findIndex(t => Object.values(t.accept).some(arr => arr.includes(ext)));
    if (matchedIdx > 0) {
        const [matched] = allTypes.splice(matchedIdx, 1);
        allTypes.unshift(matched);
    }

    if (window.showSaveFilePicker) {
        try {
            const handle = await window.showSaveFilePicker({
                suggestedName: suggestedName,
                types: allTypes
            });
            const writable = await handle.createWritable();
            await writable.write(blob);
            await writable.close();
            
            // Store handle correctly in state (per tab) 
            state.fileHandle = handle;
            
            state.tmpData.filename = handle.name;
            updateCurrentTabName(handle.name);
            const curTab = (state.activeTabIndex >= 0 && state.tabs && state.tabs[state.activeTabIndex]) ? state.tabs[state.activeTabIndex] : null;
            if (curTab) {
                curTab.isNewProject = false;
                curTab.fileHandle = handle;
                curTab.fileName = handle.name;
            }
        } catch (err) {
            if (err.name !== 'AbortError') throw err;
        }
    } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = suggestedName;
        a.click();
        URL.revokeObjectURL(url);
    }
}

export async function handleClipboardPaste(imageFile) {
    // TMP clipboard paste is complex due to diamond shape
    // For now, we'll just log it or implement a simple "paste into current tile"
    console.log("Clipboard paste not yet implemented for TMP isometric tiles.");
}

function downloadFileAsBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function handleSaveAll() {
    if (!state.tabs || state.tabs.length === 0) return;

    // Persist active tab before iterating
    const originalActive = state.activeTabIndex;
    if (originalActive >= 0 && state.tabs[originalActive]) {
        state.saveToTab(state.tabs[originalActive]);
    }

    const dialog = document.getElementById('saveAllDialog');
    const fileListEl = document.getElementById('saveAllFileList');
    const btnCancel = document.getElementById('btnCancelSaveAll');
    const btnConfirm = document.getElementById('btnConfirmSaveAll');
    const btnSaveAllZip = document.getElementById('btnSaveAllZip');
    const btnSaveAllToFolder = document.getElementById('btnSaveAllToFolder');
    const progressContainer = document.getElementById('saveAllProgressContainer');
    const progressFill = document.getElementById('saveAllProgressFill');
    const progressText = document.getElementById('saveAllProgressText');
    const progressPercent = document.getElementById('saveAllProgressPercent');

    function encodeTabToBuffer(tab, index) {
        state.activeTabIndex = index;
        state.loadFromTab(tab);
        if (!state.tmpData) return null;
        syncTmpDataForSaving();
        return TmpTsFile.encode(state.tmpData);
    }

    function updateProgress(current, total) {
        if (!progressContainer || !progressFill || !progressText || !progressPercent) return;
        progressContainer.style.display = 'block';
        const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 100;
        progressFill.style.width = pct + '%';
        progressText.textContent = (t('lbl_save_all_progress') || 'Saving {current} of {total}...')
            .replace('{current}', String(current))
            .replace('{total}', String(total));
        progressPercent.textContent = pct + '%';
    }

    // Fallback if DOM dialog is missing
    if (!dialog || !fileListEl || !btnConfirm || !btnCancel) {
        let savedCount = 0;
        for (let i = 0; i < state.tabs.length; i++) {
            const tab = state.tabs[i];
            if (!tab.hasChanges && tab.fileHandle) continue;
            state.activeTabIndex = i;
            state.loadFromTab(tab);
            await handleSaveTmp();
            state.saveToTab(tab);
            if (!state.hasChanges) savedCount++;
        }
        if (originalActive >= 0 && originalActive < state.tabs.length) {
            state.activeTabIndex = originalActive;
            state.loadFromTab(state.tabs[originalActive]);
        }
        if (window.renderTabs) window.renderTabs();
        return;
    }

    // Reset progress UI
    if (progressContainer) progressContainer.style.display = 'none';
    if (progressFill) progressFill.style.width = '0%';

    // Build the list of open files
    fileListEl.innerHTML = '';
    const modifiedIndices = [];

    state.tabs.forEach((tab, i) => {
        const filename = tab.fileName || tab.idName || (tab.tmpData?.filename) || `file_${i + 1}.tem`;
        const isModified = Boolean(tab.hasChanges || (!tab.fileHandle && (tab.tiles && tab.tiles.length > 0)));
        if (isModified) modifiedIndices.push(i);

        let badgeClass = 'badge-clean';
        let badgeText = t('lbl_file_status_clean') || 'Up to date';

        if (!tab.fileHandle) {
            badgeClass = 'badge-new';
            badgeText = t('lbl_file_status_new') || 'New (Unsaved)';
        } else if (isModified) {
            badgeClass = 'badge-modified';
            badgeText = t('lbl_file_status_modified') || 'Modified';
        }

        const row = document.createElement('div');
        row.className = 'save-all-item';
        row.id = `saveAllItem_${i}`;
        row.innerHTML = `
            <div class="save-all-item-left">
                <span class="save-all-type-tag tmp-tag">TMP</span>
                <span class="save-all-filename" title="${filename}">${filename}</span>
            </div>
            <div class="save-all-item-right">
                <span class="save-all-badge ${badgeClass}" id="saveAllBadge_${i}">${badgeText}</span>
                <span class="save-all-action-slot" id="saveAllActionSlot_${i}"></span>
            </div>
        `;
        fileListEl.appendChild(row);
    });

    btnConfirm.disabled = false;
    btnCancel.disabled = false;
    btnConfirm.classList.remove('btn-continue-pulse');
    btnConfirm.textContent = t('btn_save_all') || 'SAVE ALL';

    if (btnSaveAllZip) {
        btnSaveAllZip.disabled = false;
        btnSaveAllZip.textContent = t('btn_save_all_zip') || '📦 ZIP';
    }

    if (btnSaveAllToFolder) {
        btnSaveAllToFolder.disabled = false;
        btnSaveAllToFolder.textContent = t('btn_save_all_folder') || '📁 Save to Folder...';
        btnSaveAllToFolder.style.display = window.showDirectoryPicker ? 'inline-flex' : 'none';
    }

    // Show dialog
    if (typeof dialog.showModal === 'function') {
        if (!dialog.open) dialog.showModal();
    } else {
        dialog.setAttribute('open', '');
    }

    return new Promise((resolve) => {
        const cleanup = () => {
            btnCancel.onclick = null;
            btnConfirm.onclick = null;
            btnConfirm.classList.remove('btn-continue-pulse');
            if (btnSaveAllZip) btnSaveAllZip.onclick = null;
            if (btnSaveAllToFolder) btnSaveAllToFolder.onclick = null;

            if (typeof dialog.close === 'function') dialog.close();
            else dialog.removeAttribute('open');

            // Restore original active tab
            if (originalActive >= 0 && originalActive < state.tabs.length) {
                state.activeTabIndex = originalActive;
                state.loadFromTab(state.tabs[originalActive]);
                state.fileHandle = state.tabs[originalActive].fileHandle || null;
            }
            if (window.renderTabs) window.renderTabs();
            if (typeof window.updateUIState === 'function') window.updateUIState();
            if (typeof renderCanvas === 'function') renderCanvas();
        };

        btnCancel.onclick = () => {
            cleanup();
            resolve(false);
        };

        // --- Option 1: Save All to a Single Selected Folder ---
        if (btnSaveAllToFolder) {
            btnSaveAllToFolder.onclick = async () => {
                try {
                    const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
                    if (!dirHandle) return;

                    btnConfirm.disabled = true;
                    btnCancel.disabled = true;
                    btnSaveAllZip.disabled = true;
                    btnSaveAllToFolder.disabled = true;
                    btnSaveAllToFolder.textContent = '⏳ ...';

                    const tabsToSave = modifiedIndices.length > 0 ? modifiedIndices : state.tabs.map((_, idx) => idx);
                    let folderSaved = 0;

                    for (const idx of tabsToSave) {
                        const tab = state.tabs[idx];
                        const filename = tab.fileName || tab.idName || (tab.tmpData?.filename) || `file_${idx + 1}.tem`;
                        const badge = document.getElementById(`saveAllBadge_${idx}`);

                        if (badge) {
                            badge.className = 'save-all-badge badge-saving';
                            badge.textContent = '⏳ ...';
                        }

                        const u8 = encodeTabToBuffer(tab, idx);
                        if (u8) {
                            const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
                            const writable = await fileHandle.createWritable();
                            const blob = new Blob([u8], { type: 'application/octet-stream' });
                            await writable.write(blob);
                            await writable.close();

                            tab.fileHandle = fileHandle;
                            tab.fileName = filename;
                            tab.hasChanges = false;
                            folderSaved++;
                        }

                        if (badge) {
                            badge.className = 'save-all-badge badge-saved';
                            badge.textContent = '✅ ' + (t('lbl_save_status_saved') || 'Saved');
                        }
                        updateProgress(folderSaved, tabsToSave.length);
                    }

                    setTimeout(() => {
                        cleanup();
                        const msg = (t('msg_save_all_folder_success') || '✅ Saved {count} file(s) to folder successfully').replace('{count}', String(folderSaved));
                        showPasteNotification(msg, 'success', 3000);
                        resolve(true);
                    }, 500);
                } catch (dErr) {
                    if (dErr.name !== 'AbortError') {
                        console.error('Save to folder error:', dErr);
                        showPasteNotification('Folder save error: ' + dErr.message, 'error', 3000);
                    }
                    btnConfirm.disabled = false;
                    btnCancel.disabled = false;
                    if (btnSaveAllZip) btnSaveAllZip.disabled = false;
                    btnSaveAllToFolder.disabled = false;
                    btnSaveAllToFolder.textContent = t('btn_save_all_folder') || '📁 Save to Folder...';
                }
            };
        }

        // --- Option 2: Download All Modified Files as a single ZIP ---
        if (btnSaveAllZip) {
            btnSaveAllZip.onclick = async () => {
                try {
                    const ZipClass = (typeof MiniZip !== 'undefined') ? MiniZip : (window.MiniZip || null);
                    if (!ZipClass) {
                        showPasteNotification('ZIP utility unavailable', 'error', 2500);
                        return;
                    }

                    btnConfirm.disabled = true;
                    btnCancel.disabled = true;
                    btnSaveAllZip.disabled = true;
                    if (btnSaveAllToFolder) btnSaveAllToFolder.disabled = true;
                    btnSaveAllZip.textContent = '⏳ ...';

                    const tabsToSave = modifiedIndices.length > 0 ? modifiedIndices : state.tabs.map((_, idx) => idx);
                    const zip = new ZipClass();

                    for (const idx of tabsToSave) {
                        const tab = state.tabs[idx];
                        const filename = tab.fileName || tab.idName || (tab.tmpData?.filename) || `file_${idx + 1}.tem`;
                        const u8 = encodeTabToBuffer(tab, idx);
                        if (u8) zip.add(filename, u8);

                        tab.hasChanges = false;
                        const badge = document.getElementById(`saveAllBadge_${idx}`);
                        if (badge) {
                            badge.className = 'save-all-badge badge-saved';
                            badge.textContent = '📦 ' + (t('lbl_save_status_saved') || 'Saved');
                        }
                    }

                    const dateStr = new Date().toISOString().slice(0, 10);
                    const zipBlob = zip.generate();
                    downloadFileAsBlob(`tmp_backup_${dateStr}.zip`, zipBlob);

                    setTimeout(() => {
                        cleanup();
                        const msg = (t('msg_save_all_zip_success') || '📦 Packaged and downloaded {count} file(s) in ZIP').replace('{count}', String(tabsToSave.length));
                        showPasteNotification(msg, 'success', 3000);
                        resolve(true);
                    }, 600);
                } catch (zErr) {
                    console.error('ZIP packaging failed:', zErr);
                    showPasteNotification('ZIP failed: ' + zErr.message, 'error', 3000);
                    btnConfirm.disabled = false;
                    btnCancel.disabled = false;
                    btnSaveAllZip.disabled = false;
                    if (btnSaveAllToFolder) btnSaveAllToFolder.disabled = false;
                    btnSaveAllZip.textContent = t('btn_save_all_zip') || '📦 ZIP';
                }
            };
        }

        // --- Option 3: Continuous Overwrite to Original Disk Files ---
        let savedCount = 0;
        const totalToSave = modifiedIndices.length;

        async function runContinuousSave() {
            btnConfirm.disabled = true;
            btnCancel.disabled = true;
            btnConfirm.classList.remove('btn-continue-pulse');
            btnConfirm.textContent = '⏳ ...';
            if (btnSaveAllZip) btnSaveAllZip.disabled = true;
            if (btnSaveAllToFolder) btnSaveAllToFolder.disabled = true;

            if (totalToSave > 0) {
                updateProgress(savedCount, totalToSave);
            }

            // 1. Silent Fast Pass: direct save any tab that ALREADY has 'granted' permission
            for (const idx of modifiedIndices) {
                const tab = state.tabs[idx];
                if (!tab.hasChanges && tab.fileHandle) continue;

                if (tab.fileHandle && typeof tab.fileHandle.queryPermission === 'function') {
                    try {
                        const qPerm = await tab.fileHandle.queryPermission({ mode: 'readwrite' });
                        if (qPerm === 'granted') {
                            const u8 = encodeTabToBuffer(tab, idx);
                            if (u8) {
                                const writable = await tab.fileHandle.createWritable();
                                const blob = new Blob([u8], { type: 'application/octet-stream' });
                                await writable.write(blob);
                                await writable.close();

                                tab.hasChanges = false;
                                savedCount++;
                                const badge = document.getElementById(`saveAllBadge_${idx}`);
                                if (badge) {
                                    badge.className = 'save-all-badge badge-saved';
                                    badge.textContent = '✅ ' + (t('lbl_save_status_saved') || 'Saved');
                                }
                                updateProgress(savedCount, totalToSave);
                            }
                        }
                    } catch (qErr) {
                        console.warn('[handleSaveAll] Silent pass query error on tab', idx, qErr);
                    }
                }
            }

            // 2. Interactive Loop: Request permission and save remaining files
            for (let k = 0; k < modifiedIndices.length; k++) {
                const idx = modifiedIndices[k];
                const tab = state.tabs[idx];
                if (!tab.hasChanges && tab.fileHandle) continue;

                const badge = document.getElementById(`saveAllBadge_${idx}`);
                const actionSlot = document.getElementById(`saveAllActionSlot_${idx}`);

                if (tab.fileHandle) {
                    if (badge) {
                        badge.className = 'save-all-badge badge-saving';
                        badge.textContent = '⏳ ...';
                    }

                    try {
                        const perm = await tab.fileHandle.requestPermission({ mode: 'readwrite' });
                        if (perm === 'granted') {
                            const u8 = encodeTabToBuffer(tab, idx);
                            if (u8) {
                                const writable = await tab.fileHandle.createWritable();
                                const blob = new Blob([u8], { type: 'application/octet-stream' });
                                await writable.write(blob);
                                await writable.close();

                                tab.hasChanges = false;
                                savedCount++;
                                if (badge) {
                                    badge.className = 'save-all-badge badge-saved';
                                    badge.textContent = '✅ ' + (t('lbl_save_status_saved') || 'Saved');
                                }
                                if (actionSlot) actionSlot.innerHTML = '';
                                updateProgress(savedCount, totalToSave);
                            }
                        } else {
                            if (badge) {
                                badge.className = 'save-all-badge badge-modified';
                                badge.textContent = '⚠️ ' + (t('lbl_file_status_modified') || 'Modified');
                            }
                        }
                    } catch (reqErr) {
                        console.warn(`[handleSaveAll] Chrome activation expired at tab ${idx}:`, reqErr.message);
                        if (badge) {
                            badge.className = 'save-all-badge badge-modified';
                            badge.textContent = '⚠️ ' + (t('lbl_file_status_modified') || 'Modified');
                        }

                        const remaining = totalToSave - savedCount;
                        btnConfirm.disabled = false;
                        btnCancel.disabled = false;
                        if (btnSaveAllZip) btnSaveAllZip.disabled = false;
                        if (btnSaveAllToFolder) btnSaveAllToFolder.disabled = false;

                        btnConfirm.classList.add('btn-continue-pulse');
                        btnConfirm.textContent = (t('btn_continue_saving') || '▶️ Continue Saving ({count} left)').replace('{count}', String(remaining));
                        btnConfirm.onclick = () => runContinuousSave();
                        return;
                    }
                } else {
                    if (badge) {
                        badge.className = 'save-all-badge badge-new';
                        badge.textContent = '✚ ' + (t('lbl_file_status_new') || 'New');
                    }
                    if (actionSlot && !actionSlot.hasChildNodes()) {
                        const btnSaveAs = document.createElement('button');
                        btnSaveAs.className = 'save-all-btn-action';
                        btnSaveAs.textContent = t('btn_save_as') || 'Save As...';
                        btnSaveAs.onclick = async () => {
                            btnSaveAs.disabled = true;
                            btnSaveAs.textContent = '⏳ ...';
                            state.activeTabIndex = idx;
                            state.loadFromTab(tab);
                            const u8 = encodeTabToBuffer(tab, idx);
                            if (u8) {
                                await handleExportTmpAction(new Blob([u8], { type: 'application/octet-stream' }));
                            }
                            state.saveToTab(tab);
                            if (!tab.hasChanges) {
                                savedCount++;
                                if (badge) {
                                    badge.className = 'save-all-badge badge-saved';
                                    badge.textContent = '✅ ' + (t('lbl_save_status_saved') || 'Saved');
                                }
                                actionSlot.innerHTML = '';
                                updateProgress(savedCount, totalToSave);
                            } else {
                                btnSaveAs.disabled = false;
                                btnSaveAs.textContent = t('btn_save_as') || 'Save As...';
                            }
                        };
                        actionSlot.appendChild(btnSaveAs);
                    }
                }
            }

            // 3. All saved or processed!
            btnConfirm.classList.remove('btn-continue-pulse');
            btnConfirm.disabled = true;
            btnConfirm.textContent = '✅ ' + (t('lbl_save_status_saved') || 'Saved');

            setTimeout(() => {
                cleanup();
                if (savedCount > 0) {
                    const msg = (t('msg_save_all_success') || '✅ Saved {count} tab(s) successfully').replace('{count}', String(savedCount));
                    showPasteNotification(msg, 'success', 2500);
                } else {
                    const msg = t('msg_save_all_no_changes') || 'ℹ️ All tabs are already up to date';
                    showPasteNotification(msg, 'info', 2000);
                }
                resolve(true);
            }, 500);
        }

        btnConfirm.onclick = () => runContinuousSave();
    });
}
