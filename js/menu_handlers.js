import { state, TRANSPARENT_COLOR, generateId } from './state.js';
import { elements } from './constants.js';
import {
    showConfirm, renderCanvas,
    updateTilesList, showEditorInterface,
    updateCanvasSize, addTile, createNewProject,
    selectAll, invertSelection, copySelection, cutSelection, pasteClipboard, pasteAsNewFrame, zoomToSelection,
    copySelectedTiles, cutSelectedTiles, pasteTiles, pasteIntoSelectedTiles, pasteTilesAtEnd, deleteSelectedTiles,
    saveSelectedTilesToFile, generateZDataForSelectedTiles,
    selectAllTiles, invertTileSelection, deselectAllTiles,
    updatePixelGrid, renderTileThumbnail, setupTooltips,
    recomputeWorldBoundsFromState, updateTileProperties
} from './ui.js';
import { openNewTmpDialog, openOpenTmpDialog, updateUIState } from './main.js';
import { handleExportTmp, loadTmpData, handleSaveTmp } from './file_io.js';
import { resetImportState, syncImporterPalette } from './import_tmp.js';
import { TmpTsFile } from './tmp_format.js';
import { PcxLoader } from './pcx_loader.js';
import { findNearestPaletteIndex, setupAutoRepeat, compositeFrame } from './utils.js';
import { pushHistory, undo, redo } from './history.js';
import { t } from './translations.js';
import { closeAllPaletteMenus, getActivePaletteId, applyPaletteById, getMostRecentPaletteId, getPaletteName, findNodeById, applyPaletteFromEntry } from './palette_menu.js';
import { deselect, deleteSelection, fillSelection } from './tools.js';
import { renderPaletteSimple } from './ui.js';
import { createNewTab } from './tabs.js';
import { PREDEFINED_ZDATA } from './predefined_zdata.js';




let savedAlphaSettings = null;
let pendingFileLoad = null;

function triggerFileLoad(isForced, mode) {
    pendingFileLoad = { isForced, mode };
    const input = document.getElementById('menuLoadFileInput');
    if (input) {
        input.value = '';
        input.click();
    }
}

export function updateMenuState(hasProject) {
    window.updateMenuState = updateMenuState;
    const canSave = hasProject && !state.hasMismatches;

    const actions = [
        'menuSave', 'menuSaveAs', 'menuCloseTmp'
    ];
    actions.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            if (id === 'menuSave' || id === 'menuSaveAs') {
                el.classList.toggle('disabled', !canSave);
                el.disabled = !canSave;
            } else {
                el.classList.toggle('disabled', !hasProject);
                el.disabled = !hasProject;
            }
        }
    });

    const hasTileSelection = state.tileSelection?.size > 0;
    const hasPixelSelection = !!state.selection;

    // Edit Menu items
    const editActions = {
        'menuUndo': state.historyPtr > 0,
        'menuRedo': state.historyPtr < state.history.length - 1,
        'menuCut': hasPixelSelection || hasTileSelection,
        'menuSelectAll': hasProject,
        'menuDeselect': hasPixelSelection || hasTileSelection,
        'menuInvertSelection': hasProject,
        'menuDelete': hasPixelSelection || hasTileSelection,
        
        // Load from... triggers
        'menuLoadFromSub': hasProject,
        'menuLoadImgMerged': hasProject,
        'menuLoadImgCell': hasProject,
        'menuLoadImgExtra': hasProject,
        'menuLoadImgFullCanvas': hasProject,
        'menuLoadZMerged': hasProject,
        'menuLoadZCell': hasProject,
        'menuLoadZExtra': hasProject,
        'menuLoadZFullCanvas': hasProject,
    };

    // Advanced Copy items (Available if project exists for Whole Canvas mode)
    editActions['menuCopySub'] = hasProject;
    const copyIds = [
        'menuCopyFull', 'menuCopyOnlyCell', 'menuCopyOnlyExtra', 
        'menuCopyImgMerged', 'menuCopyImgCell', 'menuCopyImgExtra',
        'menuCopyZMerged', 'menuCopyZCell', 'menuCopyZExtra'
    ];
    copyIds.forEach(id => { editActions[id] = hasTileSelection; });
    // Whole Canvas copy is always available if project is loaded
    editActions['menuCopyImgFullCanvas'] = hasProject;
    editActions['menuCopyZFullCanvas'] = hasProject;

    // Save to... items
    editActions['menuSaveToSub'] = hasProject;
    const saveIds = [
        'menuSaveImgMerged', 'menuSaveImgCell', 'menuSaveImgExtra',
        'menuSaveZMerged', 'menuSaveZCell', 'menuSaveZExtra'
    ];
    saveIds.forEach(id => { editActions[id] = hasTileSelection; });
    editActions['menuSaveImgFullCanvas'] = hasProject;
    editActions['menuSaveZFullCanvas'] = hasProject;

    const hasData = state.internalClipboard?.type === 'tiles' || localStorage.getItem('tmp_tile_clipboard');
    // Assume system image might be available to allow menu interaction (browser blocked polling)
    const hasImage = hasProject; 

    editActions['menuPasteSub'] = hasProject && (hasData || hasImage);
    const pasteIds = [
        'menuPasteFull', 'menuPasteOnlyCell', 'menuPasteOnlyExtra'
    ];
    pasteIds.forEach(id => { editActions[id] = hasProject && (hasData || hasImage); });
    // Whole Canvas paste items
    editActions['menuPasteImgFullCanvas'] = hasProject && hasImage;
    editActions['menuPasteZFullCanvas'] = hasProject && hasImage;
    
    // Image items
    const pasteImgIds = [
        'menuPasteImgMerged', 'menuPasteImgCell', 'menuPasteImgExtra',
        'menuPasteZMerged', 'menuPasteZCell', 'menuPasteZExtra'
    ];
    pasteImgIds.forEach(id => { editActions[id] = hasProject && hasImage; });

    // Forced Paste items (Need project AND content. Selection only required for "Into" modes)
    editActions['menuPasteIntoSub'] = hasProject && (hasData || hasImage);
    const forcedIds = [
        'menuPasteIntoFull', 'menuPasteIntoOnlyCell', 'menuPasteIntoOnlyExtra',
        'menuPasteImgIntoZ', 'menuPasteZIntoImg'
    ];
    forcedIds.forEach(id => { editActions[id] = hasProject && hasTileSelection && (hasData || hasImage); });

    // Z-Data Generation Logic (Professional Procedural Tools)
    // Only enabled if we have extra data in the selection context
    let canGenerateZ = false;
    if (hasTileSelection) {
        if (state.bondSelection) {
            // In Bond mode, check if any whole tile in selection has extra data
            canGenerateZ = Array.from(state.tileSelection).some(idx => state.tiles[idx]?.tileHeader?.has_extra_data);
        } else {
            // In Unbond mode, check if any specifically selected 'extra' part exists
            canGenerateZ = Array.from(state.subSelection).some(k => k.endsWith('_extra'));
        }
    }

    const hasGenZ = hasProject && canGenerateZ;
    editActions['menuPredefinedZDataSub'] = hasProject && hasTileSelection;
    editActions['cmItemPredefinedZ'] = hasProject && hasTileSelection;
    editActions['menuGenerateZDataSub'] = hasGenZ;
    editActions['cmItemGenZ'] = hasGenZ;
    const finalGenZIds = [
        'menuGenZ_VDown', 'menuGenZ_VUp', 'menuGenZ_HRight', 'menuGenZ_HLeft',
        'menuGenZ_MirrorV', 'menuGenZ_MirrorVInv', 'menuGenZ_MirrorH', 'menuGenZ_MirrorHInv',
        'cmGenZ_VDown', 'cmGenZ_VUp', 'cmGenZ_HRight', 'cmGenZ_HLeft',
        'cmGenZ_MirrorV', 'cmGenZ_MirrorVInv', 'cmGenZ_MirrorH', 'cmGenZ_MirrorHInv'
    ];
    finalGenZIds.forEach(id => { editActions[id] = hasGenZ; });
    
    Object.entries(editActions).forEach(([id, enabled]) => {
        const el = document.getElementById(id);
        if (el) {
            el.classList.toggle('disabled', !enabled);
        }
        // Also update corresponding context menu item if it exists (prefix cm)
        const cmId = id.replace('menu', 'cm');
        const cmEl = document.getElementById(cmId);
        if (cmEl) {
            cmEl.classList.toggle('disabled', !enabled);
        }
    });

    // View Menu items
    const viewActions = [
        'menuZoomIn', 'menuZoomOut', 'menuZoom100',
        'menuToggleBackground', 'triggerGridOptions', 'triggerVisualMode', 'menuToggleGrid', 'menuToggleGameGrid', 'menuToggleFlatCells', 'menuToggleTileTable'
    ];
    viewActions.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            let enabled = hasProject;
            if (enabled) el.classList.remove('disabled');
            else el.classList.add('disabled');
        }
    });

    // Palette Menu item - disable if in Alpha Image Mode
    const palMenuItem = document.getElementById('menuItemPalettes');
    if (palMenuItem) {
        if (state.isAlphaImageMode) {
            palMenuItem.classList.add('disabled-ui');
            palMenuItem.style.pointerEvents = 'none';
            palMenuItem.style.opacity = '0.5';
        } else {
            palMenuItem.classList.remove('disabled-ui');
            palMenuItem.style.pointerEvents = 'auto';
            palMenuItem.style.opacity = '1';
        }
    }





    const controls = [
        'btnUndo', 'btnRedo', 'btnToggleGrid', 'btnToggleBg',
        'selIsoGrid', 'cbUseShadows', 'cbShowShadowOverlay'
    ];
    controls.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            let enabled = hasProject;
            if (id === 'cbShowShadowOverlay') enabled = hasProject && state.useShadows;
            if (id === 'cbUseShadows' && state.isAlphaImageMode) enabled = false;

            if (enabled) {
                el.classList.remove('disabled-ui');
                if ('disabled' in el) el.disabled = false;
            } else {
                el.classList.add('disabled-ui');
                if ('disabled' in el) el.disabled = true;
            }
            // Handle wrappers to block label clicks and dim text
            if (id === 'cbShowShadowOverlay' || id === 'cbUseShadows') {
                const wrapperId = id === 'cbShowShadowOverlay' ? 'wrapperShowShadowOverlay' : 'wrapperUseShadows';
                const wrapper = document.getElementById(wrapperId);
                if (wrapper) {
                    if (enabled) wrapper.classList.remove('disabled-ui');
                    else wrapper.classList.add('disabled-ui');
                }
            }
        }
    });




    syncMenuToggles();
}

export function syncMenuToggles() {
    const toggles = {
        'menuGridShowNone': !state.showGrid,
        'menuGridShowLight': state.showGrid && state.gridColor === 'light',
        'menuGridShowDark': state.showGrid && state.gridColor === 'dark',
        'menuToggleBg': !!state.showBackground,
        'menuToggleBackground': !!state.showBackground,
        'menuToggleShadows': !!state.useShadows,
        'menuToggleGameGrid': !!state.showGameGrid,
        'menuToggleFlatCells': !!state.flatCells,
        'menuShowCenter': !!state.showCenter,
        'menuToggleShadowOverlay': !!state.showShadowOverlay,
        'menuAlphaImageMode': !!state.isAlphaImageMode,
        'menuToggleTileTable': !!state.showTileTable,
        'menuModeNormal': state.visualMode === 'normal',
        'menuModeZData': state.visualMode === 'zdata',
        'menuModePlaceholders': state.visualMode === 'placeholders'
    };

    Object.entries(toggles).forEach(([id, active]) => {
        const el = document.getElementById(id);
        if (el) {
            if (active) el.classList.add('menu-checked');
            else el.classList.remove('menu-checked');
        }
    });

    if (elements.chkMenuModeNormal) elements.chkMenuModeNormal.classList.toggle('checked', state.visualMode === 'normal');
    if (elements.chkMenuModeZData) elements.chkMenuModeZData.classList.toggle('checked', state.visualMode === 'zdata');
    if (elements.chkMenuModePlaceholders) elements.chkMenuModePlaceholders.classList.toggle('checked', state.visualMode === 'placeholders');

    if (elements.btnToggleGrid) {
        elements.btnToggleGrid.classList.toggle('active', !!state.showGrid);
    }

    const btnToggleGameGrid = document.getElementById('btnToggleGameGrid');
    if (btnToggleGameGrid) {
        btnToggleGameGrid.classList.toggle('active', !!state.showGameGrid);
    }

    if (elements.btnToggleTileTable) {
        elements.btnToggleTileTable.classList.toggle('active', !!state.showTileTable);
    }

    const cbShadows = document.getElementById('cbUseShadows');
    if (cbShadows) cbShadows.checked = !!state.useShadows;

    const cbOverlay = document.getElementById('cbShowShadowOverlay');
    if (cbOverlay) cbOverlay.checked = !!state.showShadowOverlay;
}


export function initMenu() {
    setupMenuInteractions();
    setupFileMenu();
    setupEditMenu();
    setupViewMenu();

    setupSteppers();
    setupModalButtons();
    
    window.saveRecentFile = saveRecentFile;
}

function setupMenuInteractions() {
    const menuItems = document.querySelectorAll('#mainMenu .menu-item');

    menuItems.forEach(item => {
        const btn = item.querySelector('.menu-btn');
        if (!btn) return;

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isActive = item.classList.contains('active');

            // Close all first
            closeAllMenus();

            if (!isActive) {
                item.classList.add('active');
                if (item.id === 'menuItemEdit') { 
                    _probeClipboard(); 
                    updatePredefinedZDataMenu(); 
                }
            }
        });

        btn.addEventListener('mouseenter', () => {
            const anyActive = Array.from(menuItems).some(i => i.classList.contains('active'));
            if (anyActive) {
                closeAllMenus();
                item.classList.add('active');
                if (item.id === 'menuItemEdit') {
                    _probeClipboard();
                    updatePredefinedZDataMenu();
                }
            }
        });
    });

    window.addEventListener('click', () => closeAllMenus());
}

let _isProbing = false;
let _lastProbeTime = 0;

/** Tries to detect clipboard content type asynchronously to enable/disable paste sub-options */
async function _probeClipboard() {
    // 1. Check early exits: already probing or within 5s cooling period
    if (_isProbing) return;
    const now = Date.now();
    if (now - _lastProbeTime < 5000) return;

    _isProbing = true;
    try {
        if (!navigator.clipboard || !navigator.clipboard.read) {
             state.hasSystemImage = false;
        } else {
             // 2. Check Permissions API first to see if we can read without prompting
             // NOTE: 'clipboard-read' support varies, wrapping in try/catch
             let canRead = false;
             try {
                const status = await navigator.permissions.query({ name: 'clipboard-read' });
                if (status.state === 'granted') canRead = true;
             } catch(e) { 
                // Fallback: If browser doesn't support permissions query for clipboard-read,
                // we'll assume we shouldn't probe automatically to avoid annoying the user.
                canRead = false; 
             }

             if (canRead) {
                 const items = await navigator.clipboard.read();
                 let foundImg = false;
                 for (const it of items) {
                     if (it.types.some(t => t.startsWith('image/'))) {
                         foundImg = true;
                         break;
                     }
                 }
                 state.hasSystemImage = foundImg;
                 _lastProbeTime = now;
             } else {
                 // If not granted, we don't probe automatically. 
                 // We MUST assume true so the buttons aren't permanently disabled!
                 // The actual paste operation will prompt the user for permission.
                 state.hasSystemImage = true;
             }
        }
    } catch (e) {
        state.hasSystemImage = true; // Assume true on error so UI doesn't break
    } finally {
        _isProbing = false;
    }
    updateMenuState(!!state.tmpData);
}

function closeAllMenus() {
    closeAllPaletteMenus();
    document.querySelectorAll('.menu-item').forEach(i => i.classList.remove('active'));
}

function setupFileMenu() {
    // New
    const menuNew = document.getElementById('menuNew');
    if (menuNew) {
        menuNew.onclick = () => {
            closeAllMenus();
            openNewTmpDialog();
        };
    }

    // Open
    const menuOpen = document.getElementById('menuOpen');
    if (menuOpen) {
        menuOpen.onclick = () => {
            closeAllMenus();
            openOpenTmpDialog();
        };
    }
    // Save
    const menuSave = document.getElementById('menuSave');
    if (menuSave) {
        menuSave.onclick = () => {
            closeAllMenus();
            handleSaveTmp();
        };
    }

    // Save As
    const menuSaveAs = document.getElementById('menuSaveAs');
    if (menuSaveAs) {
        menuSaveAs.onclick = () => {
            console.log("[Menu] Save As clicked.");
            closeAllMenus();
            handleExportTmp();
        };
    }




    // Close TMP
    const menuCloseTmp = document.getElementById('menuCloseTmp');
    if (menuCloseTmp) {
        menuCloseTmp.onclick = async () => {
            closeAllMenus();
            if (!state.tiles || state.tiles.length === 0) return;

            const confirmed = await showConfirm(t('dlg_confirm_title'), t('msg_confirm_close_shp') || "Are you sure? Any unsaved changes will be lost.");
            if (confirmed) {
                state.tiles = [];
                state.tmpData = null;
                state.worldBounds = null;
                state.currentTileIdx = -1;
                state.tileSelection.clear();
                state.selection = null;
                state.floatingSelection = null;
                state.showTileTable = false;
                state.hasChanges = false;
                if (elements.tileDataTablePanel) elements.tileDataTablePanel.style.display = 'none';

                // Reset the current tab's name and project state
                if (window.updateCurrentTabName) window.updateCurrentTabName('', false);
                if (state.activeTabIndex !== -1 && state.tabs[state.activeTabIndex]) {
                    state.saveToTab(state.tabs[state.activeTabIndex]);
                }

                showEditorInterface();
                updateCanvasSize();
                renderCanvas();
                updateTilesList();
                updateUIState();
                if (window.renderTabs) window.renderTabs();
            }

        };
    }
}





function setupSteppers() {
    document.querySelectorAll('.stepper-ui, .input-stepper').forEach(stepper => {
        const input = stepper.querySelector('input');
        const btnDec = stepper.querySelector('button:first-of-type');
        const btnInc = stepper.querySelector('button:last-of-type');

        const updateValue = (delta, ev) => {
            const stepMod = (ev && ev.ctrlKey) ? 5 : 1;
            const isPct = input.id === 'inpResizePct';

            if (isPct) {
                const currentVal = parseFloat(input.value) || 0;
                const decimals = currentVal - Math.floor(currentVal);
                let val = Math.floor(currentVal) + (delta * stepMod) + decimals;
                const min = input.hasAttribute('min') ? parseFloat(input.getAttribute('min')) : -Infinity;
                const max = input.hasAttribute('max') ? parseFloat(input.getAttribute('max')) : Infinity;
                input.value = Math.max(min, Math.min(max, val)).toFixed(2);
            } else {
                let val = parseInt(input.value) || 0;
                const min = input.hasAttribute('min') ? parseInt(input.getAttribute('min')) : -Infinity;
                const max = input.hasAttribute('max') ? parseInt(input.getAttribute('max')) : Infinity;
                input.value = Math.max(min, Math.min(max, val + (delta * stepMod)));
            }
            input.dispatchEvent(new Event('input'));
            input.dispatchEvent(new Event('change'));
        };

        if (btnDec && input) setupAutoRepeat(btnDec, (ev) => updateValue(-1, ev));
        if (btnInc && input) setupAutoRepeat(btnInc, (ev) => updateValue(1, ev));

        if (input) {
            input.onchange = () => {
                let val = parseFloat(input.value) || 0;
                const min = input.hasAttribute('min') ? parseFloat(input.getAttribute('min')) : -Infinity;
                const max = input.hasAttribute('max') ? parseFloat(input.getAttribute('max')) : Infinity;
                if (val < min) input.value = min;
                if (val > max) input.value = max;
                if (input.id !== 'inpResizePct') input.value = Math.round(val);
                input.dispatchEvent(new Event('input'));
            };
        }
    });
}




async function toggleAlphaImageMode() {
    state.isAlphaImageMode = !state.isAlphaImageMode;

    if (state.isAlphaImageMode) {
        // Save current settings
        savedAlphaSettings = {
            paletteId: getActivePaletteId(),
            useShadows: state.useShadows,
            compression: state.compression
        };

        // Switch to alpha_image palette
        applyPaletteById('game_ra2_alpha_image');

        // Disable shadows
        state.useShadows = false;
        const cbShadows = document.getElementById('cbUseShadows');
        if (cbShadows) cbShadows.checked = false;

        // Force compression 1
        state.compression = 1;

    } else {
        // Restore settings
        if (savedAlphaSettings) {
            if (savedAlphaSettings.paletteId) {
                applyPaletteById(savedAlphaSettings.paletteId);
            }
            state.useShadows = savedAlphaSettings.useShadows;
            const cbShadows = document.getElementById('cbUseShadows');
            if (cbShadows) cbShadows.checked = state.useShadows;

            state.compression = savedAlphaSettings.compression;
        }
    }

    syncMenuToggles();
    updateMenuState(state.tiles.length > 0);
    renderCanvas();
    if (typeof updateTilesList === 'function') updateTilesList();
}

function setupModalButtons() {

}





function setupEditMenu() {
    const handlers = {
        'menuUndo': () => undo(),
        'menuRedo': () => redo(),
        'menuCut': () => { 
            if (state.tileSelection.size > 0) cutSelectedTiles(); 
            else cutSelection(); 
        },
        // --- COPY ---
        'menuCopyFull': () => copySelectedTiles('full'),
        'menuCopyOnlyCell': () => copySelectedTiles('only_cell'),
        'menuCopyOnlyExtra': () => copySelectedTiles('only_extra'),
        'menuCopyImgMerged': () => copySelectedTiles('img_merged'),
        'menuCopyImgCell': () => copySelectedTiles('img_cell'),
        'menuCopyImgExtra': () => copySelectedTiles('img_extra'),
        'menuCopyZMerged': () => copySelectedTiles('z_merged'),
        'menuCopyZCell': () => copySelectedTiles('z_cell'),
        'menuCopyZExtra': () => copySelectedTiles('z_extra'),
        'menuCopyImgFullCanvas': () => copySelectedTiles('img_total'),
        'menuCopyZFullCanvas': () => copySelectedTiles('z_total'),
        
        // --- SAVE TO ---
        'menuSaveImgMerged': () => saveSelectedTilesToFile('img_merged'),
        'menuSaveImgCell': () => saveSelectedTilesToFile('img_cell'),
        'menuSaveImgExtra': () => saveSelectedTilesToFile('img_extra'),
        'menuSaveImgFullCanvas': () => saveSelectedTilesToFile('img_total'),
        'menuSaveZMerged': () => saveSelectedTilesToFile('z_merged'),
        'menuSaveZCell': () => saveSelectedTilesToFile('z_cell'),
        'menuSaveZExtra': () => saveSelectedTilesToFile('z_extra'),
        'menuSaveZFullCanvas': () => saveSelectedTilesToFile('z_total'),

        // --- DATA PLACEHOLDER ---
        'menuCopyPlaceMerged': () => copySelectedTiles('place_merged'),
        'menuCopyPlaceCell': () => copySelectedTiles('place_cell'),
        'menuCopyPlaceExtra': () => copySelectedTiles('place_extra'),
        'menuCopyPlaceCanvas': () => copySelectedTiles('place_total'),

        // --- PASTE (Normal Append) ---
        'menuPasteFull': () => pasteTiles(false, 'full', true),
        'menuPasteOnlyCell': () => pasteTiles(false, 'only_cell', true),
        'menuPasteOnlyExtra': () => pasteTiles(false, 'only_extra', true),
        'menuPasteImgMerged': () => pasteTiles(false, 'img_merged', true),
        'cmPasteImgCell': () => pasteTiles(false, 'img_cell', true),
        'menuPasteImgCell': () => pasteTiles(false, 'img_cell', true),
        'menuPasteImgExtra': () => pasteTiles(false, 'img_extra', true),
        'menuPasteZMerged': () => pasteTiles(false, 'z_merged', true),
        'menuPasteZCell': () => pasteTiles(false, 'z_cell', true),
        'menuPasteZExtra': () => pasteTiles(false, 'z_extra', true),
        'menuPasteImgFullCanvas': () => pasteTiles(false, 'img_total', true),
        'menuPasteZFullCanvas': () => pasteTiles(false, 'z_total', true),

        // --- FORCED PASTE (Overwrite) ---
        'menuPasteIntoFull': () => pasteTiles(true, 'full', true),
        'menuPasteIntoOnlyCell': () => pasteTiles(true, 'only_cell', true),
        'menuPasteIntoOnlyExtra': () => pasteTiles(true, 'only_extra', true),
        'menuPasteImgIntoZ': () => pasteTiles(true, 'img_to_z', true),
        'menuPasteZIntoImg': () => pasteTiles(true, 'z_to_img', true),
        'menuGenZ_VDown': () => generateZDataForSelectedTiles('vdown'),
        'menuGenZ_VUp': () => generateZDataForSelectedTiles('vup'),
        'menuGenZ_HRight': () => generateZDataForSelectedTiles('hright'),
        'menuGenZ_HLeft': () => generateZDataForSelectedTiles('hleft'),
        'menuGenZ_MirrorV': () => generateZDataForSelectedTiles('mirrorv'),
        'menuGenZ_MirrorVInv': () => generateZDataForSelectedTiles('mirrorv_inv'),
        'menuGenZ_MirrorH': () => generateZDataForSelectedTiles('mirrorh'),
        'menuGenZ_MirrorHInv': () => generateZDataForSelectedTiles('mirrorh_inv'),

        'menuDelete': () => {
            if (state.tileSelection.size > 0) deleteSelectedTiles();
            else deleteSelection();
        },
        'menuSelectAll': () => {
            selectAllTiles(); 
        },
        'menuDeselect': () => {
            deselectAllTiles();
            deselect(); // standardized pixel deselect
        },
        'menuInvertSelection': () => invertTileSelection(),
        
        // --- LOAD FROM ---
        'menuLoadImgMerged': () => triggerFileLoad(true, 'img_merged'),
        'menuLoadImgCell': () => triggerFileLoad(true, 'img_cell'),
        'menuLoadImgExtra': () => triggerFileLoad(true, 'img_extra'),
        'menuLoadImgFullCanvas': () => triggerFileLoad(true, 'img_total'),
        'menuLoadZMerged': () => triggerFileLoad(true, 'z_merged'),
        'menuLoadZCell': () => triggerFileLoad(true, 'z_cell'),
        'menuLoadZExtra': () => triggerFileLoad(true, 'z_extra'),
        'menuLoadZFullCanvas': () => triggerFileLoad(true, 'z_total'),
    };

    Object.entries(handlers).forEach(([id, fn]) => {
        const el = document.getElementById(id);
        if (el) {
            el.onclick = (e) => {
                e.stopPropagation();
                closeAllMenus();
                fn();
            };
        }
    });

    // Setup file input listener for "Load from..." options
    const input = document.getElementById('menuLoadFileInput');
    if (input) {
        input.onchange = async (e) => {
            if (!e.target.files.length) return;
            const file = e.target.files[0];
            if (pendingFileLoad && window.processSystemImagePaste) {
                const { isForced, mode } = pendingFileLoad;
                
                if (file.name.toLowerCase().endsWith('.pcx')) {
                    const reader = new FileReader();
                    reader.onload = async (re) => {
                        try {
                            const loader = new PcxLoader(re.target.result);
                            const pcx = loader.decode();
                            
                            // Convert PCX (Indexed) to RGB ImageData for unified processing
                            const canvas = document.createElement('canvas');
                            canvas.width = pcx.width;
                            canvas.height = pcx.height;
                            const ctx = canvas.getContext('2d');
                            const imgData = ctx.createImageData(pcx.width, pcx.height);
                            const data = imgData.data;
                            
                            for (let i = 0; i < pcx.indices.length; i++) {
                                const idx = pcx.indices[i];
                                const c = pcx.palette[idx] || { r: 0, g: 0, b: 0 };
                                const off = i * 4;
                                // Handle Magic Pink (253,0,253) for modding compatibility
                                const isMagicPink = (c.r === 253 && c.g === 0 && c.b === 253);
                                data[off] = c.r; data[off+1] = c.g; data[off+2] = c.b; 
                                data[off+3] = (isMagicPink ? 0 : 255);
                            }
                            
                            window.processSystemImagePaste(imgData, mode, isForced);
                        } catch (err) {
                            console.error("PCX load failed:", err);
                            if (window.showPasteNotification) window.showPasteNotification("Failed to decode PCX: " + err.message, "error");
                        }
                    };
                    reader.readAsArrayBuffer(file);
                } else {
                    window.processSystemImagePaste(file, mode, isForced);
                }
            }
            pendingFileLoad = null;
        };
    }
}

function setupViewMenu() {
    const handlers = {
        'menuZoomIn': () => {
            let val = parseInt(elements.inpZoom.value);
            if (elements.inpZoom) elements.inpZoom.value = Math.min(5000, val < 100 ? 100 : Math.floor(val / 100) * 100 + 100);
            if (elements.inpZoom) elements.inpZoom.dispatchEvent(new Event('input'));
        },
        'menuZoomOut': () => {
            let val = parseInt(elements.inpZoom.value);
            if (elements.inpZoom) elements.inpZoom.value = Math.max(50, val <= 100 ? 50 : Math.ceil(val / 100) * 100 - 100);
            if (elements.inpZoom) elements.inpZoom.dispatchEvent(new Event('input'));
        },
        'menuZoomToSelection': () => zoomToSelection(),
        'menuZoom100': () => {
            if (elements.inpZoom) elements.inpZoom.value = 100;
            if (elements.inpZoom) elements.inpZoom.dispatchEvent(new Event('input'));
        },
        'menuShowCenter': () => {
            state.showCenter = !state.showCenter;
            syncMenuToggles();
            renderOverlay();
        },
        'menuGridShowNone': () => {
            state.showGrid = false;
            updatePixelGrid();
            syncMenuToggles();
        },
        'menuGridShowLight': () => {
            state.showGrid = true;
            state.gridColor = 'light';
            updatePixelGrid();
            syncMenuToggles();
        },
        'menuGridShowDark': () => {
            state.showGrid = true;
            state.gridColor = 'dark';
            updatePixelGrid();
            syncMenuToggles();
        },
        'menuToggleBg': () => {
            state.showBackground = !state.showBackground;
            const btn = document.getElementById('btnToggleBg');
            if (btn) btn.classList.toggle('active', state.showBackground);
            renderCanvas();
            updateTilesList();
            syncMenuToggles();
        },
        'menuToggleBackground': () => {
            state.showBackground = !state.showBackground;
            const btn = document.getElementById('btnToggleBg');
            if (btn) btn.classList.toggle('active', state.showBackground);
            renderCanvas();
            updateTilesList();
            syncMenuToggles();
        },
        'menuToggleGameGrid': () => {
            state.showGameGrid = !state.showGameGrid;
            renderCanvas();
            syncMenuToggles();
        },
        'menuToggleFlatCells': () => {
            state.flatCells = !state.flatCells;
            recomputeWorldBoundsFromState();
            renderCanvas();
            updateTilesList();
            syncMenuToggles();
        },
        'menuToggleTileTable': () => {
             if (elements.btnToggleTileTable) elements.btnToggleTileTable.click();
        },
        'menuModeNormal': () => {
            state.visualMode = 'normal';
            syncMenuToggles();
            renderCanvas();
            updateTilesList();
        },
        'menuModeZData': () => {
            state.visualMode = 'zdata';
            syncMenuToggles();
            renderCanvas();
            updateTilesList();
        },
        'menuModePlaceholders': () => {
            state.visualMode = 'placeholders';
            syncMenuToggles();
            renderCanvas();
            updateTilesList();
        },

        'menuToggleShadows': () => {
            state.useShadows = !state.useShadows;
            const cb = document.getElementById('cbUseShadows');
            if (cb) cb.checked = state.useShadows;
            if (state.useShadows && state.primaryColorIdx > 1) {
                state.primaryColorIdx = 1;
                state.paletteSelection.clear();
                state.paletteSelection.add(1);
            }
            if (typeof renderPalette === 'function') renderPalette();
            renderCanvas();
            if (typeof updateTilesList === 'function') updateTilesList();
            syncMenuToggles();
        },
        'menuShowCenter': () => {
            state.showCenter = !state.showCenter;
            renderCanvas();
            syncMenuToggles();
        },
        'menuToggleShadowOverlay': () => {
            const cb = document.getElementById('cbShowShadowOverlay');
            if (cb) cb.click();
        },
        'menuAlphaImageMode': () => {
            toggleAlphaImageMode();
        }
    };

    Object.entries(handlers).forEach(([id, fn]) => {
        const el = document.getElementById(id);
        if (el) {
            el.onclick = (e) => {
                e.stopPropagation();
                closeAllMenus();
                fn();
            };
        }
    });
}





// ============================================================
// RECENT FILES (File System Access API + IndexedDB)
// ============================================================

const RECENT_DB_NAME = 'cc_tmp_recent_v1';
const RECENT_STORE = 'files';
const MAX_RECENT = 10;

function openRecentDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(RECENT_DB_NAME, 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(RECENT_STORE)) {
                db.createObjectStore(RECENT_STORE, { keyPath: 'id', autoIncrement: true });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function getRecentFiles() {
    try {
        const db = await openRecentDB();
        return new Promise((resolve) => {
            const tx = db.transaction(RECENT_STORE, 'readonly');
            const store = tx.objectStore(RECENT_STORE);
            const req = store.getAll();
            req.onsuccess = () => {
                const items = req.result || [];
                // Sort newest first
                items.sort((a, b) => b.timestamp - a.timestamp);
                resolve(items.slice(0, MAX_RECENT));
            };
            req.onerror = () => resolve([]);
        });
    } catch {
        return [];
    }
}

export async function saveRecentFile(name, handle) {
    if (!handle) return;
    try {
        const db = await openRecentDB();
        const tx = db.transaction(RECENT_STORE, 'readwrite');
        const store = tx.objectStore(RECENT_STORE);

        // Fetch existing entries in the same transaction to prevent race conditions
        const existing = await new Promise((resolve, reject) => {
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });

        // Remove duplicates by name
        for (const item of existing) {
            if (item.name === name) {
                store.delete(item.id);
            }
        }

        // Add new entry with palette reference and game info
        const paletteId = getActivePaletteId() || null;
        let game = '';
        if (state.tmpData && state.tmpData.header) {
            game = state.tmpData.header.cx === 48 ? 'TS' : 'RA2';
        }
        store.add({ name, handle, paletteId, game, timestamp: Date.now() });

        // Trim old entries (keep only MAX_RECENT)
        const sorted = existing.filter(i => i.name !== name);
        sorted.sort((a, b) => b.timestamp - a.timestamp);
        const toRemove = sorted.slice(MAX_RECENT - 1); // -1 because we just added one
        for (const item of toRemove) {
            store.delete(item.id);
        }

        await new Promise((resolve, reject) => {
            tx.oncomplete = resolve;
            tx.onerror = reject;
        });

        // Refresh menu (debounced)
        renderRecentFilesMenu();
    } catch (err) {
        console.warn('[Recent Files] Save failed:', err);
    }
}

async function clearRecentFiles() {
    try {
        const db = await openRecentDB();
        const tx = db.transaction(RECENT_STORE, 'readwrite');
        tx.objectStore(RECENT_STORE).clear();
        await new Promise((resolve) => { tx.oncomplete = resolve; });
        renderRecentFilesMenu();
    } catch (err) {
        console.warn('[Recent Files] Clear failed:', err);
    }
}

async function openRecentFile(handle, paletteId, openInNewTab = false) {
    try {
        // Request permission
        const perm = await handle.requestPermission({ mode: 'read' });
        if (perm !== 'granted') {
            console.warn('[Recent Files] Permission denied');
            return;
        }

        const file = await handle.getFile();
        const buf = await file.arrayBuffer();

        if (openInNewTab) {
            createNewTab();
        }

        const ext = file.name.split('.').pop().toLowerCase();
        const validExts = ['tem', 'sno', 'urb', 'des', 'ubn', 'lun', 'tmp'];
        if (validExts.includes(ext)) {
            if (!openInNewTab && state.hasChanges && state.tmpData) {
                const confirmed = await showConfirm(t('dlg_confirm_title'), t('msg_confirm_close_tab') || "Are you sure? Any unsaved changes will be lost.");
                if (!confirmed) return;
            }

            // Restore palette: try saved palette first, fallback to most recent
            let paletteRestored = false;
            if (paletteId) {
                paletteRestored = applyPaletteById(paletteId);
            }
            if (!paletteRestored) {
                const fallbackId = getMostRecentPaletteId();
                if (fallbackId) {
                    applyPaletteById(fallbackId);
                }
            }

            const tmp = TmpTsFile.parse(buf);
            loadTmpData(tmp);
            
            // 2.5 Update Tab Name
            if (window.updateCurrentTabName) {
                window.updateCurrentTabName(file.name);
            }

            // Force clean state after all initialization triggers
            state.hasChanges = false;
            if (window.renderTabs) window.renderTabs();

            // Store handle for Save functionality
            window._lastTmpFileHandle = handle;

            // Save updated timestamp
            saveRecentFile(file.name, handle);

            if (typeof window.updateUIState === 'function') window.updateUIState();
            closeAllMenus();
        }
    } catch (err) {
        console.error('[Recent Files] Failed to open:', err);
        alert('Failed to open recent file: ' + err.message);
    }
}

let renderMenuTimer = null;
async function renderRecentFilesMenu() {
    if (renderMenuTimer) clearTimeout(renderMenuTimer);
    renderMenuTimer = setTimeout(async () => {
        await doRenderRecentFilesMenu();
    }, 50);
}

async function doRenderRecentFilesMenu() {
    const container = document.getElementById('menuRecentContainer');
    const submenu = document.getElementById('menuRecentSubmenu');
    const emptyMsg = document.getElementById('menuRecentEmpty');
    if (!submenu) return;

    const items = await getRecentFiles();

    // Clear existing dynamic items
    Array.from(submenu.children).forEach(child => {
        if (child.id !== 'menuRecentEmpty') child.remove();
    });

    if (items.length === 0) {
        if (container) container.style.display = 'none';
        if (emptyMsg) emptyMsg.style.display = 'block';
        return;
    }

    if (container) container.style.display = '';
    if (emptyMsg) emptyMsg.style.display = 'none';

    for (const item of items) {
        const div = document.createElement('div');
        div.className = 'menu-action';
        div.style.height = 'auto';
        div.style.padding = '6px 10px';

        const palName = getPaletteName(item.paletteId) || t('lbl_default');
        const dateStr = new Date(item.timestamp).toLocaleString();

        div.title = `${t('lbl_file')}: ${item.name}\n${t('lbl_date')}: ${dateStr}\n${t('lbl_palette')}: ${palName}`;

        const gameSuffix = item.game ? ` (${item.game})` : '';
        div.innerHTML = `
            <span class="menu-icon icon-file-tmp" style="align-self: flex-start; margin-top: 4px;"></span>
            <div style="display:flex; flex-direction:column; line-height:1.2; overflow:hidden;">
                <span style="font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${item.name}${gameSuffix}</span>
                <span style="font-size: 10px; color: #718096; font-style: italic;">${dateStr} \u00b7 ${palName}</span>
            </div>
        `;
        div.onclick = (e) => {
            e.stopPropagation();
            const inNewTab = e.ctrlKey || e.shiftKey || e.metaKey;
            openRecentFile(item.handle, item.paletteId, inNewTab);
        };
        submenu.appendChild(div);
    }

    // Add separator + Clear Recent
    const sep = document.createElement('div');
    sep.className = 'menu-divider';
    submenu.appendChild(sep);

    const clearBtn = document.createElement('div');
    clearBtn.className = 'menu-action';
    clearBtn.innerHTML = `<span style="color:#a0aec0; font-style:italic;">${t("btn_clear_recent")}</span>`;
    clearBtn.onclick = (e) => {
        e.stopPropagation();
        clearRecentFiles();
        closeAllMenus();
    };
    submenu.appendChild(clearBtn);

    // Re-setup submenus to ensure the newly added recent files have correct positioning logic
    if (typeof setupSubmenusRecursive === 'function') {
        setupSubmenusRecursive(document.querySelector('#mainMenu'), 0);
    }
}

export function initRecentFiles() {
    const trigger = document.getElementById('triggerRecent');
    if (trigger) {
        // Refresh when hovering
        trigger.addEventListener('mouseenter', renderRecentFilesMenu);
        // Prevent menu from closing when clicking the trigger to open the submenu
        trigger.addEventListener('click', (e) => e.stopPropagation());
    }
    renderRecentFilesMenu();
}

// --- CONTEXT MENU MAPPING ---
const cmMap = {
    'cmUndo': () => undo(),
    'cmRedo': () => redo(),
    'cmCut': () => cutSelectedTiles(),
    'cmCopyFull': () => copySelectedTiles('full'),
    'cmCopyOnlyCell': () => copySelectedTiles('only_cell'),
    'cmCopyOnlyExtra': () => copySelectedTiles('only_extra'),
    'cmCopyImgMerged': () => copySelectedTiles('img_merged'),
    'cmCopyImgCell': () => copySelectedTiles('img_cell'),
    'cmCopyImgExtra': () => copySelectedTiles('img_extra'),
    'cmCopyImgFullCanvas': () => copySelectedTiles('img_total'),
    'cmCopyZMerged': () => copySelectedTiles('z_merged'),
    'cmCopyZCell': () => copySelectedTiles('z_cell'),
    'cmCopyZExtra': () => copySelectedTiles('z_extra'),
    'cmCopyZFullCanvas': () => copySelectedTiles('z_total'),
    'cmCopyPlaceMerged': () => copySelectedTiles('place_merged'),
    'cmCopyPlaceCell': () => copySelectedTiles('place_cell'),
    'cmCopyPlaceExtra': () => copySelectedTiles('place_extra'),
    'cmCopyPlaceCanvas': () => copySelectedTiles('place_total'),

    'cmPasteFull': () => pasteTiles(false, 'full', true),
    'cmPasteOnlyCell': () => pasteTiles(false, 'only_cell', true),
    'cmPasteOnlyExtra': () => pasteTiles(false, 'only_extra', true),
    'cmPasteImgMerged': () => pasteTiles(false, 'img_merged', true),
    'cmPasteImgCell': () => pasteTiles(false, 'img_cell', true),
    'cmPasteImgExtra': () => pasteTiles(false, 'img_extra', true),
    'cmPasteImgFullCanvas': () => pasteTiles(false, 'img_total', true),
    'cmPasteZMerged': () => pasteTiles(false, 'z_merged', true),
    'cmPasteZCell': () => pasteTiles(false, 'z_cell', true),
    'cmPasteZExtra': () => pasteTiles(false, 'z_extra', true),
    'cmPasteZFullCanvas': () => pasteTiles(false, 'z_total', true),

    'cmPasteIntoFull': () => pasteTiles(true, 'full', true),
    'cmPasteIntoOnlyCell': () => pasteTiles(true, 'only_cell', true),
    'cmPasteIntoOnlyExtra': () => pasteTiles(true, 'only_extra', true),
    'cmPasteImgIntoZ': () => pasteTiles(true, 'img_to_z', true),
    'cmPasteZIntoImg': () => pasteTiles(true, 'z_to_img', true),

    'cmLoadImgMerged': () => triggerFileLoad(true, 'img_merged'),
    'cmLoadImgCell': () => triggerFileLoad(true, 'img_cell'),
    'cmLoadImgExtra': () => triggerFileLoad(true, 'img_extra'),
    'cmLoadImgFullCanvas': () => triggerFileLoad(true, 'img_total'),
    'cmLoadZMerged': () => triggerFileLoad(true, 'z_merged'),
    'cmLoadZCell': () => triggerFileLoad(true, 'z_cell'),
    'cmLoadZExtra': () => triggerFileLoad(true, 'z_extra'),
    'cmLoadZFullCanvas': () => triggerFileLoad(true, 'z_total'),

    'cmSaveImgMerged': () => saveSelectedTilesToFile('img_merged'),
    'cmSaveImgCell': () => saveSelectedTilesToFile('img_cell'),
    'cmSaveImgExtra': () => saveSelectedTilesToFile('img_extra'),
    'cmSaveImgFullCanvas': () => saveSelectedTilesToFile('img_total'),
    'cmSaveZMerged': () => saveSelectedTilesToFile('z_merged'),
    'cmSaveZCell': () => saveSelectedTilesToFile('z_cell'),
    'cmSaveZExtra': () => saveSelectedTilesToFile('z_extra'),
    'cmSaveZFullCanvas': () => saveSelectedTilesToFile('z_total'),
    'cmSelectAll': () => selectAllTiles(),
    'cmDeselect': () => deselectAllTiles(),
    'cmInvertSelection': () => invertTileSelection(),
    'cmDelete': () => deleteSelectedTiles(),
    'cmGenZ_VDown': () => generateZDataForSelectedTiles('vdown'),
    'cmGenZ_VUp': () => generateZDataForSelectedTiles('vup'),
    'cmGenZ_HRight': () => generateZDataForSelectedTiles('hright'),
    'cmGenZ_HLeft': () => generateZDataForSelectedTiles('hleft'),
    'cmGenZ_MirrorV': () => generateZDataForSelectedTiles('mirrorv'),
    'cmGenZ_MirrorVInv': () => generateZDataForSelectedTiles('mirrorv_inv'),
    'cmGenZ_MirrorH': () => generateZDataForSelectedTiles('mirrorh'),
    'cmGenZ_MirrorHInv': () => generateZDataForSelectedTiles('mirrorh_inv')
};

export function initTileContextMenuHandlers() {
    Object.entries(cmMap).forEach(([id, fn]) => {
        const el = document.getElementById(id);
        if (el) {
            el.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                hideTileContextMenu();
                fn();
            };
        }
    });

    // Global click listener to hide context menu
    document.addEventListener('mousedown', (e) => {
        const menu = document.getElementById('tileContextMenu');
        if (menu && !menu.contains(e.target)) {
            hideTileContextMenu();
        }
    });
    window.addEventListener('blur', () => hideTileContextMenu());
    window.addEventListener('scroll', () => hideTileContextMenu(), true);
}

export function showTileContextMenu(x, y) {
    const menu = document.getElementById('tileContextMenu');
    if (!menu) return;

    // Refresh enabled states before showing
    updateMenuState(!!state.tmpData);
    updatePredefinedZDataMenu();

    menu.style.display = 'block';
    
    // Bounds check to avoid overflow
    const mw = menu.offsetWidth || 220;
    const mh = menu.offsetHeight || 300;
    const ww = window.innerWidth;
    const wh = window.innerHeight;

    let targetX = x;
    let targetY = y;

    // If main menu overflows right, shift it left
    // We also consider that a submenu might open to the right (assume ~200px)
    const expectedSubmenuW = 200;
    if (targetX + mw + expectedSubmenuW > ww && targetX > mw) {
        // Shift main menu left so submenu opens to the left or fits better
        // But for now, just ensure the main menu itself is in bounds
    }

    if (targetX + mw > ww) targetX = ww - mw - 5;
    if (targetX < 5) targetX = 5;

    if (targetY + mh > wh) targetY = wh - mh - 5;
    if (targetY < 5) targetY = 5;

    menu.style.left = targetX + 'px';
    menu.style.top = targetY + 'px';

    // Smart Submenu Positioning (Upwards if close to bottom)
    const submenus = menu.querySelectorAll('.cm-submenu');
    submenus.forEach(sub => {
        // Reset previously forced styles
        sub.style.top = '';
        sub.style.bottom = '';
        sub.style.left = '';
        sub.style.right = '';

        // Check vertical space for this specific submenu when it opens 
        // (Approximate height or attach a mouseenter listener)
    });

    // Add dynamic listeners for submenus to prevent overflow
    if (!menu._initSubmenuEvents) {
        menu.addEventListener('mouseover', (e) => {
            const item = e.target.closest('.cm-has-submenu');
            if (item) {
                const sub = item.querySelector('.cm-submenu');
                if (sub) {
                    const rect = sub.getBoundingClientRect();
                    const itemRect = item.getBoundingClientRect();
                    const ww = window.innerWidth;
                    const wh = window.innerHeight;

                    // Vertical check
                    const buffer = 10;
                    const subHeight = sub.offsetHeight || sub.getBoundingClientRect().height;
                    
                    // 1. Try to open downwards (default)
                    if (itemRect.top + subHeight < wh - buffer) {
                        sub.style.top = '-5px';
                        sub.style.bottom = 'auto';
                    } 
                    // 2. If it doesn't fit below, try to open upwards from the bottom of the trigger
                    else if (itemRect.bottom - subHeight > buffer) {
                        sub.style.top = 'auto';
                        sub.style.bottom = '0';
                    } 
                    // 3. If it doesn't fit in either direction, force it to the top of the viewport
                    else {
                        sub.style.bottom = 'auto';
                        // Position it so its global Y is at 'buffer'
                        // Formula: absolute_pos = parent_pos + relative_top
                        // relative_top = buffer - parent_pos
                        sub.style.top = (buffer - itemRect.top) + 'px';
                    }

                    // Horizontal check
                    const subWidth = sub.offsetWidth || 280; // Fallback to 280px for wide Z-Data submenu
                    if (itemRect.right + subWidth > ww - 10) {
                        // Doesn't fit on the right, try opening to the left
                        if (itemRect.left - subWidth > 10) {
                            sub.style.left = 'auto';
                            sub.style.right = '100%';
                        } else {
                            // Doesn't fit on the left either, force it to the left edge of viewport
                            sub.style.right = 'auto';
                            sub.style.left = (10 - itemRect.left) + 'px';
                        }
                    }
                }
            }
        }, true);
        menu._initSubmenuEvents = true;
    }
}

export function hideTileContextMenu() {
    const menu = document.getElementById('tileContextMenu');
    if (menu) menu.style.display = 'none';
}

// Predefined Z-Data implementation
function updatePredefinedZDataMenu() {
    [['predefinedZDataDropdown', 'menuPredefinedZDataSub'], ['ctxPredefinedZDataDropdown', 'cmItemPredefinedZ']].forEach(([dId, rootId]) => {
        const d = document.getElementById(dId);
        const menuRoot = document.getElementById(rootId);
        if (!d || !menuRoot || !state.tmpData) {
            if(menuRoot) menuRoot.classList.add('disabled');
            return;
        }

        if (!state.tileSelection || state.tileSelection.size === 0) {
            menuRoot.classList.add('disabled');
            return;
        }
        menuRoot.classList.remove('disabled');

        const gt = state.gameType || 'ts';
        const dataObj = PREDEFINED_ZDATA[gt];
        if (!dataObj || Object.keys(dataObj).length === 0) {
            d.innerHTML = '<div class="pal-menu-section-label" style="text-align:center;">No pre-defined Z-Data</div>';
            return;
        }

        let html = '';
        
        // Sort keys. Remember 21,22 are BASE CELDA. The rest are EXTRA DATA.
        const keys = Object.keys(dataObj).map(Number).sort((a,b)=>a-b);
        const baseKeys = keys.filter(k => k === 21 || k === 22);
        const extraKeys = keys.filter(k => k !== 21 && k !== 22);

        let hasBaseSelected = false;
        let hasExtraSelected = false;
        
        if (state.bondSelection) {
            // In Bond mode, since we select the whole tile entity, we show both parts
            // if we have corresponding data for them.
            hasBaseSelected = state.tileSelection.size > 0;
            hasExtraSelected = state.tileSelection.size > 0;
        } else {
            hasBaseSelected = Array.from(state.subSelection).some(k => k.endsWith('_base'));
            hasExtraSelected = Array.from(state.subSelection).some(k => k.endsWith('_extra'));
        }

        if (hasBaseSelected && baseKeys.length > 0) {
            html += `<div class="pal-menu-section-label header-data" style="margin-top:0;">${t('lbl_cell_caps')}</div>`;
            html += '<div style="display:flex; flex-wrap:wrap; gap:8px; padding:0 12px; margin-bottom:12px; align-items:center;">';
            for(let k of baseKeys) {
                html += `<img src="${dataObj[k]}" style="width:auto; height:auto; max-height:80px; border:1px solid #444; border-radius:2px; cursor:pointer; image-rendering:pixelated; object-fit:contain;" onclick="applyPredefinedZData('${gt}', ${k}, 'base')" onmouseover="this.style.borderColor='#00ffaa'" onmouseout="this.style.borderColor='#444'" title="Index ${k}">`;
            }
            html += '</div>';
        }

        if (hasExtraSelected && extraKeys.length > 0) {
            html += `<div class="pal-menu-section-label header-data">${t('lbl_extra_data_caps')}</div>`;
            html += '<div style="display:flex; flex-wrap:wrap; gap:8px; padding:0 12px; margin-bottom:12px; align-items:center;">';
            for(let k of extraKeys) {
                html += `<img src="${dataObj[k]}" style="width:auto; height:auto; max-height:80px; border:1px solid #444; border-radius:2px; cursor:pointer; image-rendering:pixelated; object-fit:contain;" onclick="applyPredefinedZData('${gt}', ${k}, 'extra')" onmouseover="this.style.borderColor='#00ffaa'" onmouseout="this.style.borderColor='#444'" title="Index ${k}">`;
            }
            html += '</div>';
        }

        if (html === '') {
            html = '<div class="pal-menu-section-label" style="text-align:center; padding: 10px;">Selection mismatch</div>';
        }

        d.innerHTML = html;
    });
}

/**
 * Recomputes the internal bounding box and relative offsets for a tile state object.
 * This is critical after any structural changes (resizing, adding extra data) to prevent world-bounds corruption.
 */
function recomputeTileStateBounds(t) {
    const h = t.tileHeader;
    if (!h) return;

    const mult = (state.gameType === 'ra2') ? 1.25 : 1.0;
    const dx = h.x;
    const dy = h.y - (h.height || 0) * mult;
    let minX = dx, minY = dy;
    let maxX = dx + state.cx, maxY = dy + state.cy;

    const ex = h.x_extra || 0;
    const ey = (h.y_extra || 0) - (h.height || 0) * mult;

    // 1. Extra Image Footprint
    if (h.has_extra_data) {
        const ew = t._extraImg_cx || h.cx_extra || 0;
        const eh = t._extraImg_cy || h.cy_extra || 0;
        if (ew > 0 && eh > 0) {
            minX = Math.min(minX, ex);
            minY = Math.min(minY, ey);
            maxX = Math.max(maxX, ex + ew);
            maxY = Math.max(maxY, ey + eh);
        }
    }

    // 2. Extra Z-Data Footprint (Independent of Image)
    if (h.has_extra_data && h.has_z_data) {
        const zw = t._extraZ_cx || h.cx_extra || 0;
        const zh = t._extraZ_cy || h.cy_extra || 0;
        if (zw > 0 && zh > 0) {
            minX = Math.min(minX, ex);
            minY = Math.min(minY, ey);
            maxX = Math.max(maxX, ex + zw);
            maxY = Math.max(maxY, ey + zh);
        }
    }

    t.itemMinX = minX;
    t.itemMinY = minY;
    t.width = maxX - minX;
    t.height = maxY - minY;
    t.diamondX = dx - minX;
    t.diamondY = dy - minY;
    if (h.has_extra_data) {
        t.extraX = ex - minX;
        t.extraY = ey - minY;
    }
}

window.recomputeTileStateBounds = recomputeTileStateBounds;

window.applyPredefinedZData = function(game, idx, targetType) {
    if (!state.tmpData || !state.tiles.length || !state.tileSelection.size) return;
    
    const b64 = PREDEFINED_ZDATA[game][idx];
    if (!b64) return;
    
    const img = new Image();
    img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const imgData = ctx.getImageData(0, 0, img.width, img.height);
        const data = imgData.data;
        
        const zBuffer = new Uint8Array(img.width * img.height);
        for(let i=0; i<zBuffer.length; i++) {
            const r = data[i*4];
            const a = data[i*4+3];
            
            // Map 0-255 PNG value to 0-31 TMP Z-level.
            // If the PNG pixel is fully transparent, treat it as Z=255 (no-data/transparent).
            if (a < 128) {
                zBuffer[i] = 255;
            } else {
                // Scaling: (val / 255) * 31
                zBuffer[i] = Math.round((r * 31) / 255);
            }
        }
        
        pushHistory(Array.from(state.tileSelection));
        
        const halfCy = state.cy / 2;
        const mult = halfCy;

        state.tileSelection.forEach(tileIndex => {
            const t = state.tiles[tileIndex];
            if (!t) return;
            
            const isBaseTarget = state.bondSelection || state.subSelection.has(`${tileIndex}_base`);
            const isExtraTarget = state.bondSelection || state.subSelection.has(`${tileIndex}_extra`);

            if (targetType === 'base') {
                if (isBaseTarget) {
                    const expectedSize = state.cx * state.cy;
                    if (!t.zData || t.zData.length !== expectedSize) {
                        t.zData = new Uint8Array(expectedSize);
                    }
                    if (zBuffer.length === expectedSize) {
                        t.zData.set(zBuffer);
                        if (t.tileHeader) {
                            t.tileHeader.has_z_data = true;
                        }
                    }
                }
            } else if (targetType === 'extra') {
                if (isExtraTarget) {
                    const h = t.tileHeader;
                    if (!h) return;

                    const srcW = img.width;
                    const srcH = img.height;
                    const srcSize = srcW * srcH;

                    // 1. Apply Z-Data buffer and its independent dimensions
                    t.extraZData = new Uint8Array(zBuffer);
                    t._extraZ_cx = srcW;
                    t._extraZ_cy = srcH;
                    
                    // 2. Flags
                    h.has_extra_data = 1;
                    h.has_z_data = 1;

                    // 3. Coordinate Safety
                    if (h.x_extra === undefined || Math.abs(h.x_extra) > 100000) h.x_extra = h.x || 0;
                    if (h.y_extra === undefined || Math.abs(h.y_extra) > 100000) h.y_extra = h.y || 0;

                    // 4. Update shared header (cx_extra/cy_extra) to the MAXIMUM footprint of both layers.
                    // The canvas rendering (drawLayer, hit-testing, bounding box) reads cx_extra directly,
                    // so it MUST reflect the true combined size. Independent dims (_extraZ_cx, _extraImg_cx)
                    // take priority in the mini-panel renderer, but cx_extra drives the main canvas view.
                    const imgCxPre = t._extraImg_cx || h.cx_extra || 0;
                    const imgCyPre = t._extraImg_cy || h.cy_extra || 0;

                    // Bake the independent dimension into the image if it's currently relying on the shared header
                    if (t.extraImageData && !t._extraImg_cx) {
                        t._extraImg_cx = imgCxPre;
                        t._extraImg_cy = imgCyPre;
                    }

                    h.cx_extra = Math.max(srcW, imgCxPre);
                    h.cy_extra = Math.max(srcH, imgCyPre);

                    // 5. Force full bounds recompute so the main canvas reflects the new size immediately
                    t._v = (t._v || 0) + 1;
                    if (typeof moveTileBy === 'function') moveTileBy(tileIndex, 0, 0, false);
                }
            }
        });
        
        closeAllMenus();
        if (window.recomputeWorldBoundsFromState) window.recomputeWorldBoundsFromState();
        renderCanvas();
        if(typeof updateTileProperties === 'function') updateTileProperties();
        if(window.updateTilesList) window.updateTilesList();
    };
    img.src = b64;
};
