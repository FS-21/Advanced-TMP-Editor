/**
 * Advanced TMP Editor
 * Copyright (C) 2026 FS-21
 * 
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 * 
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Lesser General Public License for more details.
 * 
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import { state } from './state.js';
import { elements } from './constants.js';
import {
    initMenu, updateMenuState, initRecentFiles,
    initTileContextMenuHandlers, showTileContextMenu, hideTileContextMenu
} from './menu_handlers.js';
import {
    renderCanvas, renderOverlay, updateCanvasSize, updateTilesList, setupTooltips,
    setupSubmenusRecursive, setupPaletteMenu, updateMismatchNotification, renderPalette, initHistoryHooks,
    selectAllTiles, deselectAllTiles, invertTileSelection, selectTileAt, selectTilesInRect,
    copySelectedTiles, cutSelectedTiles, pasteTiles, pasteTilesAtEnd, deleteSelectedTiles, updateTileProperties, updateExtraBtnState, updateTileDataTable
} from './ui.js';
import { redo, undo, pushHistory } from './history.js';
import { initLanguageSelector } from './translations.js';
import { initImportTmp, initExportTmp, loadTmpData } from './file_io.js';
import { setupColorShiftUIListeners } from './tools.js';
import { initTabs, updateCurrentTabName, createNewTab, closeTab } from './tabs.js';
import { TmpTsFile } from './tmp_format.js';

// Toggle UI visibility based on whether project is loaded
function updateUIState() {
    const hasProject = !!state.tmpData;

    // Get elements
    const topBarControls = document.getElementById('topBarControls');
    const toolProperties = document.getElementById('toolProperties');
    const headerToolProperties = document.getElementById('headerToolProperties');
    const panelRight = document.querySelector('.panel-right');
    const toolsBar = document.getElementById('toolsBar');
    const statusBar = document.querySelector('.status-bar');

    // Toggle visibility
    if (topBarControls) {
        topBarControls.style.display = hasProject ? 'flex' : 'none';
    }
    if (panelRight) {
        panelRight.style.display = hasProject ? 'flex' : 'none';
    }
    const panelLeft = document.querySelector('.panel-left') || elements.panelLeft;
    if (panelLeft) {
        panelLeft.style.display = hasProject ? 'flex' : 'none';
    }
    if (toolProperties) toolProperties.style.display = 'none';
    if (headerToolProperties) headerToolProperties.style.display = 'none';
    if (elements.btnToggleTileTable) elements.btnToggleTileTable.disabled = !hasProject;

    // Update menu state (enabled/disabled actions)
    updateMenuState(hasProject);
    
    // Check for mismatches in current project
    if (hasProject) {
        updateMismatchNotification();
    }

    // Update tabs visual state
    if (window.renderTabs) window.renderTabs();
    if (window.renderTabList) window.renderTabList();

    // Disable Undo/Redo if no more history steps
    if (elements.btnUndo) {
        elements.btnUndo.disabled = (state.historyPtr <= 0);
        elements.btnUndo.classList.toggle('disabled', state.historyPtr <= 0);
    }
    if (elements.btnRedo) {
        elements.btnRedo.disabled = (state.historyPtr >= state.history.length - 1);
        elements.btnRedo.classList.toggle('disabled', state.historyPtr >= state.history.length - 1);
    }
}


function init() {
    window.updateUIState = updateUIState;
    window.undo = undo;
    window.redo = redo;
    try {
        initTabs(); // Initialize Chrome-like tabs
        console.log("TRACE: init started");

        initLanguageSelector(); // Init translations

        // Refresh UI when language changes (for dynamically rendered components)
        window.addEventListener('languagechange', () => {
            updateTilesList();
            updateTilesList();
            renderPalette();
            updateUIState();
            if (typeof refreshPalettesMenuDynamic === 'function') refreshPalettesMenuDynamic();
        });

        // Initialize Circular Dependencies Hooks
        initHistoryHooks(
            () => { // onRestore callback
                renderCanvas();
                renderOverlay(); // Ensure overlay is rendered on history restore
                if (state.selection) startAnts(); // Refresh ants if selection exists
                if (typeof renderPalette === 'function') renderPalette();
                updateTilesList();
            },
            updateTilesList, startAnts, stopAnts, updateUIState,
            updateTileProperties, updateTileDataTable,
            updateCanvasSize, recomputeWorldBoundsFromState
        );

        console.log("TRACE: Hooks initialized");
        renderPalette();
        console.log("TRACE: Palette rendered");
        setupZoomOptions();
        console.log("TRACE: Zoom options setup");
        setupEventListeners();
        console.log("TRACE: Event listeners setup");
        initMenu();

        console.log("TRACE: Menu initialized");

        initNewTmpDialog();
        initImportTmp(handleConfirmImport);
        initExportTmp();
        console.log("TRACE: project created");

        updateCanvasSize(); // Ensure wrapper is hidden initially
        console.log("TRACE: Canvas size updated");

        setupPaletteMenu();
        console.log("TRACE: Palette Menu initialized");

        initRecentFiles();
        console.log("TRACE: Recent Files initialized");
        
        if (typeof initTileContextMenuHandlers === 'function') initTileContextMenuHandlers();

        renderOverlay(); // Initialize selection button states
        updateUIState(); // Set initial state (disabled menus if no project)
        setupColorShiftUIListeners();
        
        setupTooltips(); // Initialize Advanced Tooltips
        setupSubmenusRecursive(); // Initialize Menu Hover logic
        
        console.log("TRACE: init finished");

        // Splash Screen Logic
        setTimeout(() => {
            const splash = document.getElementById('splashScreen');
            if (splash) {
                splash.classList.add('hidden');
                setTimeout(() => splash.remove(), 1000); // Remove from DOM after transition
            }
        }, 1500);

        // PWA File Handling
        if ('launchQueue' in window) {
            window.launchQueue.setConsumer(async (launchParams) => {
                if (!launchParams.files.length) return;
                for (const handle of launchParams.files) {
                    const file = await handle.getFile();
                    if (typeof processSystemFileOpen === 'function') {
                        await processSystemFileOpen(file, handle);
                    }
                }
            });
        }

        // Initialize UI state visibility
        updateUIState();

        // Responsive resize listener
        window.addEventListener('resize', () => {
            updateCanvasSize();
            renderCanvas();
        });

        // Disable native right-click context menu globally, but show custom one for certain areas
        window.addEventListener('contextmenu', (e) => {
            const canvasWrapper = elements.canvasWrapper || document.getElementById('canvasWrapper');
            const tilesList = elements.tilesList || document.getElementById('tilesList');
            const dataTable = document.getElementById('tileDataTablePanel');

            if ((canvasWrapper && canvasWrapper.contains(e.target)) || 
                (tilesList && tilesList.contains(e.target)) || 
                (dataTable && dataTable.contains(e.target))) {
                
                e.preventDefault();

                if (typeof showTileContextMenu === 'function') {
                    showTileContextMenu(e.clientX, e.clientY);
                }
            } else {
                e.preventDefault();
                if (typeof hideTileContextMenu === 'function') hideTileContextMenu();
            }
        });



    } catch (err) {
        console.error("Critical Init Error:", err);
        alert(t('msg_err_init').replace('{{error}}', err.message).replace('{{stack}}', err.stack));
    }
}

// Global logger to catch early errors
window.onerror = function (msg, url, lineNo, columnNo, error) {
    alert(t('msg_err_global').replace('{{error}}', msg).replace('{{url}}', url).replace('{{line}}', lineNo).replace('{{col}}', columnNo));
    return false;
};

window.addEventListener('keydown', (e) => {
    if (e.key === 'Control') state.isCtrlPressed = true;
});
window.addEventListener('keyup', (e) => {
    if (e.key === 'Control') state.isCtrlPressed = false;
});

let isDraggingTiles = false;
let dragTilesStart = null;
let lastDragTilesPos = null;

function setupEventListeners() {
    // Shortcuts
    window.addEventListener('keydown', async (e) => {
        if (!e.key) return;
        const k = e.key.toLowerCase();
        const ctrl = e.ctrlKey || e.metaKey;

        if (k === 'g' && !ctrl) {
            state.showGrid = !state.showGrid;
            updatePixelGrid();
            syncMenuToggles();
        }

        if (ctrl && k === 'z') {
            e.preventDefault();
            if (e.shiftKey) redo(); else undo();
        } else if (ctrl && k === 'y') {
            e.preventDefault(); redo();
        }

        // Consolidated Shortcuts
        if (ctrl && k === 'a') {
            if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
            e.preventDefault();
            selectAllTiles();
        }
        if (ctrl && k === 'c') {
            if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
            e.preventDefault();
            copySelectedTiles('full');
        }
        if (ctrl && k === 'x') {
            if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
            e.preventDefault();
            cutSelectedTiles();
        }
        if (ctrl && k === 'd') {
            if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
            e.preventDefault();
            deselectAllTiles();
        }
        if (ctrl && k === 'i') {
            if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
            e.preventDefault();
            invertTileSelection();
        }
        if (k === 'delete') {
            if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
            e.preventDefault();
            deleteSelectedTiles();
        }
        if (k === 'backspace') {
            if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
            e.preventDefault();
            fillSelection();
        }
        if (ctrl && k === 'b') {
            e.preventDefault();
            zoomToSelection();
        }
        let digitStr = '';
        if (e.code && e.code.startsWith('Digit') && e.code.length === 6) {
            digitStr = e.code.charAt(5);
        } else if (e.code && e.code.startsWith('Numpad') && e.code.length === 7) {
            digitStr = e.code.charAt(6);
        } else if (k >= '0' && k <= '9') {
            digitStr = k; 
        }

        // --- IMAGE & Z-DATA SHORTCUTS (1-8) ---
        if (digitStr >= '1' && digitStr <= '8') {
            const num = parseInt(digitStr);
            if (e.shiftKey && !ctrl && !e.altKey) {
                e.preventDefault();
                const modes = ['img_cell', 'img_extra', 'img_merged', 'img_total', 'z_cell', 'z_extra', 'z_merged', 'z_total'];
                copySelectedTiles(modes[num - 1]);
                return;
            }
            if (e.altKey && !ctrl && !e.shiftKey) {
                e.preventDefault();
                const modes = ['img_cell', 'img_extra', 'img_merged', 'img_total', 'z_cell', 'z_extra', 'z_merged', 'z_total'];
                pasteTiles(false, modes[num - 1]);
                return;
            }
        }

        // --- TECHNICAL DATA COPY (CTRL + 1-2) ---
        if (ctrl && !e.shiftKey && !e.altKey) {
            if (digitStr === '1') {
                e.preventDefault();
                copySelectedTiles('only_cell');
            }
            if (digitStr === '2') {
                e.preventDefault();
                copySelectedTiles('only_extra');
            }
        }
        if (ctrl && k === '0') {
            e.preventDefault();
            const btn = document.getElementById('menuShowCenter');
            if (btn) btn.click();
        }
        if (ctrl && k === 's') {
            e.preventDefault();
            if (e.shiftKey) {
                showExportDialog();
            } else {
                handleSaveTmp();
            }
        }
        if (ctrl && k === 'n') {
            e.preventDefault();
            openNewTmpDialog();
        }
        if (ctrl && k === 'o') {
            e.preventDefault();
            if (elements.importTmpDialog) elements.importTmpDialog.showModal();
        }

        /* Removed in TMP Editor
        if (e.altKey && k === 'q') {
            e.preventDefault();
            openPreview();
        }
        */

        /* Removed in TMP Editor
        if (e.altKey && k === 'i') {
            e.preventDefault();
            const btn = document.getElementById('menuFixShadows');
            if (btn && !btn.classList.contains('disabled')) btn.click();
        }
        */

        if (ctrl && k === 'l') {
            e.preventDefault();
            const btn = document.getElementById('toggleGridColor');
            if (btn) btn.click();
        }

        if (k === 'f2') {
            e.preventDefault();
            renameActiveLayer();
        }

        if (['input', 'textarea', 'select'].includes(document.activeElement.tagName.toLowerCase())) return;

        if (!ctrl) {
            if (k === 'm') {
                if (activeTool === 'movePixels') setTool('moveSelectionArea');
                else setTool('movePixels');
            }
            if (k === 's') setTool('select');
            if (k === 'n') setTool('lasso');
            if (k === 'w') setTool('wand');
            if (k === 'i') setTool('picker');
        }
        // Removed redundant deleteSelection call here, it's handled by 'delete' key
        // if (k === 'delete' && state.selection) deleteSelection();

        // Keyboard Nudge (Arrow Keys)
        if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
            // If in move mode, move selection area/pixels
            if (state.moveMode && state.selection) {
                e.preventDefault();
                if (!state.isMovingSelection && !state.floatingSelection) {
                    state.isMovingSelection = true;
                    startMovingSelectionPixels();
                    state.isMovingSelection = false;
                }

                if (state.floatingSelection) {
                    const step = e.shiftKey ? 10 : 1;
                    if (k === 'arrowleft') state.floatingSelection.x -= step;
                    if (k === 'arrowright') state.floatingSelection.x += step;
                    if (k === 'arrowup') state.floatingSelection.y -= step;
                    if (k === 'arrowdown') state.floatingSelection.y += step;

                    state.selection.x = state.floatingSelection.x;
                    state.selection.y = state.floatingSelection.y;

                    renderCanvas();
                    renderOverlay();
                    updateActiveLayerPreview();
                    try { updateTilesList(); } catch (err) { }
                }
            } else if (!state.moveMode && (k === 'arrowup' || k === 'arrowdown')) {
                // If NOT in move mode, use arrows to navigate the visible cells list/data table
                e.preventDefault();
                const dir = (k === 'arrowup') ? -1 : 1;
                navigateTiles(dir);
            }
        }
    });


    // Shortcuts
    // Shortcuts
    // elements.btnNew.onclick handled by initNewTmpDialog

    // Generic element guards for toolbar/topbar buttons (some might be hidden/removed)


    // Export Dialog handled via menu_handlers.js now.
    // btnSaveTmp and btnOpenTmp are not in the DOM anymore.

    // Save Dialog Buttons
    if (elements.btnCancelExpTmp) {
        if (elements.btnCancelExpTmp) elements.btnCancelExpTmp.onclick = () => {
            if (elements.exportTmpDialog) elements.exportTmpDialog.close();
        };
    }
    if (elements.btnConfirmExpTmp) {
        if (elements.btnConfirmExpTmp) elements.btnConfirmExpTmp.onclick = handleExportTmp;
    }


    if (elements.fileInTmp) elements.fileInTmp.onchange = async (e) => {
        if (!e.target.files.length) return;
        const buf = await e.target.files[0].arrayBuffer();
        try {
            const tmp = TmpTsFile.parse(buf);
            loadTmpData(tmp);
        } catch (err) {
            console.error("Failed to load TMP:", err);
            alert(t('msg_err_load_tmp').replace('{{error}}', err.message));
        }
 finally {
            if (elements.fileInTmp) elements.fileInTmp.value = '';
        }
    };
    
    if (elements.fileInZData) elements.fileInZData.onchange = (e) => {
        const file = e.target.files[0];
        if (file && window._pendingZType && window._pendingZIdx !== undefined) {
            importZData(file, window._pendingZType, window._pendingZIdx);
        }
        e.target.value = ''; // Reset
    };

    if (elements.fileInSurfaceData) elements.fileInSurfaceData.onchange = (e) => {
        const file = e.target.files[0];
        if (file && window._pendingImportIdx !== undefined) {
            importSurfaceData(file, 'base', window._pendingImportIdx);
        }
        e.target.value = ''; // Reset
    };

    if (elements.fileInExtraData) elements.fileInExtraData.onchange = (e) => {
        const file = e.target.files[0];
        if (file && window._pendingImportIdx !== undefined) {
            importSurfaceData(file, 'extra', window._pendingImportIdx);
        }
        e.target.value = ''; // Reset
    };

    if (elements.btnUndo) {
        elements.btnUndo.onclick = (e) => {
            e.stopPropagation();
            undo();
        };
    }
    if (elements.btnRedo) {
        elements.btnRedo.onclick = (e) => {
            e.stopPropagation();
            redo();
        };
    }




    // View Options
    // View Options
    // View Options logic updated to professional brush size control


    // --- TOOLS ---


    /* Removed in TMP Editor
    const btnOpenPreview = document.getElementById('btnOpenPreview');
    if (btnOpenPreview) {
        btnOpenPreview.onclick = () => openPreview();
    }
    */

    // Tool Properties
    // Old brushSize listener removed

    // --- TOOLS ---
    // Drawing tools were removed from the UI in TMP adaptation.
    // Basic interaction for selection/picking remains in ui.js.


    // --- SELECTION & INTERACTION ---
    if (elements.chkFlatCells) {
        elements.chkFlatCells.onchange = (e) => {
            state.flatCells = e.target.checked;
            recomputeWorldBoundsFromState();
            renderCanvas();
        };
    }
    const toggleTileTable = () => {
        const panel = elements.tileDataTablePanel;
        if (!panel) return;
        
        state.showTileTable = !state.showTileTable;
        panel.style.display = state.showTileTable ? 'flex' : 'none';
        
        if (elements.btnToggleTileTable) elements.btnToggleTileTable.classList.toggle('active', state.showTileTable);
        if (elements.chkMenuTileTable) elements.chkMenuTileTable.checked = state.showTileTable;
        
        if (state.showTileTable) updateTileDataTable();
    };

    if (elements.btnToggleTileTable) elements.btnToggleTileTable.onclick = toggleTileTable;
    if (elements.menuToggleTileTable) elements.menuToggleTileTable.onclick = toggleTileTable;
    if (elements.chkBondSelection) {
        elements.chkBondSelection.onchange = (e) => {
            const nowBond = e.target.checked;
            const wasBond = state.bondSelection;
            state.bondSelection = nowBond;

            if (!nowBond && wasBond) {
                // Switching Bond → Unbond: populate subSelection from the current tileSelection
                // so the selection is preserved visually in decoupled mode.
                state.subSelection.clear();
                Array.from(state.tileSelection).forEach(idx => {
                    const numIdx = parseInt(idx, 10);
                    state.subSelection.add(`${numIdx}_base`);
                    const tile = state.tiles[numIdx];
                    if (tile && tile.tileHeader && tile.tileHeader.has_extra_data && tile.extraImageData) {
                        state.subSelection.add(`${numIdx}_extra`);
                    }
                    state.currentTileKey = `${numIdx}_base`;
                });
            } else if (nowBond && !wasBond) {
                // Switching Unbond → Bond: rebuild tileSelection from subSelection
                state.tileSelection.clear();
                Array.from(state.subSelection).forEach(k => {
                    const pid = parseInt(k.split('_')[0], 10);
                    if (!isNaN(pid)) state.tileSelection.add(pid);
                });
                state.subSelection.clear();
                state.currentTileKey = null;
                if (state.tileSelection.size > 0) {
                    state.currentTileIdx = Array.from(state.tileSelection)[0];
                }
            }

            updateTilesList();
            renderCanvas();
            updateExtraBtnState();
        };
    }




    // --- SELECTION & INTERACTION ---
    // Core selection logic is maintained in ui.js via context menus or automatic tools.

    // Canvas Interaction
    const scArea = elements.canvasScrollArea;
    let sprayInterval = null;

    const stopSpraying = () => {
        if (sprayInterval) {
            clearInterval(sprayInterval);
            sprayInterval = null;
        }
    };

    window.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return; // Only handle Left Clicks for workspace tools/selection
        
        const workspace = elements.canvasScrollArea || elements.canvasArea;
        if (!workspace) return;

        // Broad detection: Is the click anywhere in the center panel area?
        if (!workspace.contains(e.target)) return;

        // Ignore UI components specifically
        if (e.target.closest('.toolbar-horizontal') || e.target.closest('.panel-header') || e.target.closest('button') || e.target.closest('select') || e.target.closest('input')) {
            return;
        }

        // Avoid blocking scrollbar clicks
        if (e.target === elements.canvasScrollArea) {
            if (e.offsetX > e.target.clientWidth || e.offsetY > e.target.clientHeight) {
                return;
            }
        }

        const { x, y } = getPos(e);
        e.preventDefault(); // Prevent text selection/native dragging

        if (state.moveMode && state.tileSelection.size > 0) {
            const hitIdx = pickTileIndexAt(x, y);
            if (hitIdx !== -1 && state.tileSelection.has(hitIdx)) {
                isDraggingTiles = true;
                dragTilesStart = { x, y };
                lastDragTilesPos = { x, y };
                pushHistory();
                return;
            }
        }

        // 2. Move Selection Logic

        // Feature: Auto-select entire layer if calling Move without selection
        if (activeTool === 'movePixels' && !state.selection) {
            const frame = state.tiles[state.currentTileIdx];
            if (frame) {
                state.selection = {
                    type: 'rect',
                    x: 0, y: 0, w: frame.width, h: frame.height
                };
                // We don't need renderCanvas here necessarily as startMoving will handle preview
            }
        }

        // Handle scaling/rotation check
        if (activeTool === 'movePixels' && state.selection && !state.isMovingSelection) {
            const handleIdx = getSelectionHandleAt(x, y, state.selection, state.zoom);
            if (handleIdx !== null) {
                if (!state.floatingSelection) {
                    startMovingSelectionPixels();
                }
                if (state.floatingSelection) {
                    if (handleIdx === 8) {
                        state.isRotatingSelection = true;
                        const s = state.selection;
                        const cx = s.x + s.w / 2;
                        const cy = s.y + s.h / 2;
                        state.rotationStartAngle = Math.atan2(y - cy, x - cx);
                        state.rotationBaseAngle = 0; // Start fresh for this drag
                    } else {
                        state.isScalingSelection = true;
                        state.scaleHandleIdx = handleIdx;
                    }

                    state.dragStart = { x, y };
                    state.dragStartFloating = {
                        x: state.floatingSelection.x,
                        y: state.floatingSelection.y,
                        w: state.floatingSelection.w,
                        h: state.floatingSelection.h
                    };
                    setIsDrawing(true);
                    return;
                }
            }
        }

        if ((activeTool === 'movePixels' || activeTool === 'moveSelectionArea') && state.selection) {
            if (activeTool === 'movePixels' && !state.floatingSelection) {
                startMovingSelectionPixels();
            }
            if (activeTool === 'movePixels') {
                // Crash Fix: Ensure floatingSelection exists (it might fail if layer is hidden)
                if (state.floatingSelection) {
                    state.isMovingSelection = true;
                    state.dragStartFloating = { x: state.floatingSelection.x, y: state.floatingSelection.y };
                }
            } else { // This else is for activeTool === 'moveSelectionArea'
                state.isMovingSelectionArea = true;
                state.dragStartFloating = { x: state.selection.x, y: state.selection.y };
            }

            state.dragStart = { x, y };
            setIsDrawing(true);
            setLastPos({ x, y });
            return;
        }

        setIsDrawing(true);
        setLastPos({ x, y });
        state.currentX = x;
        state.currentY = y;
        if (!activeTool) {
            return;
        }

        if (activeTool === 'picker') {
            const idx = pickColor(x, y, e.ctrlKey);
            setIsDrawing(false);
            // Default Picker behavior (Primary Color)
            return;
        }

        // --- TMP CELL SELECTION (MARQUEE) ---
        if (activeTool === 'select' || !activeTool) {
            state.isSelecting = true;
            state.startSel = { x, y };
            state.ctrlHeld = e.ctrlKey;
            state.shiftHeld = e.shiftKey;
            renderOverlay();
        }
    });

    window.addEventListener('mousemove', (e) => {
        // Optimization: Skip if mouse is NOT over the workspace area
        const scArea = elements.canvasScrollArea;
        const isOverWorkspace = scArea && (e.target === scArea || scArea.contains(e.target));
        
        // Forbid calculation if over UI elements specifically
        const isOverUI = e.target.closest('.toolbar-horizontal, .panel-header, button, select, input, .properties-panel, .ui-tooltip, #topBar, .status-bar, #tileDataTablePanel, #panelRight, #panelLeft');

        if (!isOverWorkspace || isOverUI) {
            if (elements.coordsDisplay) elements.coordsDisplay.innerText = "";
            const tooltip = document.getElementById('uiTooltip');
            // Hide specific Game Grid tooltip if visible
            if (tooltip && tooltip.classList.contains('active')) {
                tooltip.classList.remove('active');
                tooltip.style.display = 'none';
            }
            return;
        }


        const { x, y } = getPos(e);
        if (state.isSelecting) {
            renderOverlay(x, y, activeTool, state.startSel);
        }

        if (elements.coordsDisplay) {
            const viewBounds = state.viewBounds || state.worldBounds || { minX: 0, minY: 0 };
            const halfCx = state.cx / 2;
            const halfCy = state.cy / 2;
            const absX = x + viewBounds.minX;
            const absY = y + viewBounds.minY;
            
            // Try ground projection for coordinates
            const hitTile = findTileAt(x, y);
            const elevation = hitTile ? (hitTile.tileHeader.height * halfCy) : 0;
            
            const wx = Math.round(absX - halfCx);
            const wy = Math.round(absY + elevation);
            elements.coordsDisplay.innerText = `${wx}, ${wy}`;
        }
        state.currentX = x;
        state.currentY = y;

        const tooltip = document.getElementById('uiTooltip');
        
        // Game Grid Tooltip
        if (state.showGameGrid && activeTool !== 'picker') {
            const cx = state.cx;
            const cy = state.cy;
            const halfCx = cx / 2;
            const halfCy = cy / 2;
            
            // Try Hit-test first to get actual tile coordinates if we're over a tile
            const hitTile = findTileAt(x, y);
            let finalX, finalY;
            
            if (hitTile) {
                // Return its technical base coordinates from header
                finalX = Math.round(hitTile.tileHeader.x);
                finalY = Math.round(hitTile.tileHeader.y);
            } else {
                // Calculate ground projection relative to origin
                const viewBounds = state.viewBounds || state.worldBounds || { minX: 0, minY: 0 };
                const absX = x + viewBounds.minX - halfCx;
                const absY = y + viewBounds.minY;
                
                const gx = Math.floor((absY / halfCy + absX / halfCx) / 2);
                const gy = Math.floor((absY / halfCy - absX / halfCx) / 2);
                
                finalX = Math.round(halfCx * (gx - gy));
                finalY = Math.round(halfCy * (gx + gy));
            }
            
            if (tooltip) {
                tooltip.innerHTML = `
                    <div style="font-size:11px; color:#00ffaa; font-weight:bold; padding:2px 4px;">POS: ${finalX}, ${finalY}</div>
                `;
                tooltip.style.left = (e.clientX + 15) + 'px';
                tooltip.style.top = (e.clientY + 15) + 'px';
                tooltip.classList.add('active');
                tooltip.style.display = 'block';
            }
        }

        // Picker Tool Feedback: Show tooltip and highlight palette cell
        if (activeTool === 'picker') {
            const frame = state.tiles[state.currentTileIdx];
            if (frame) {
                let foundIdx = null;
                const activeLayer = getActiveLayer();

                if (activeLayer && activeLayer.visible && x >= 0 && x < activeLayer.width && y >= 0 && y < activeLayer.height) {
                    const idx = activeLayer.data[y * activeLayer.width + x];
                    if (idx !== TRANSPARENT_COLOR) {
                        foundIdx = idx;
                    }
                }

                if (foundIdx !== null) {
                    const c = state.palette[foundIdx];
                    if (tooltip && c) {
                        tooltip.innerHTML = `<div class="tooltip-index">${foundIdx}</div><div class="tooltip-rgb">RGB: ${c.r}, ${c.g}, ${c.b}</div>`;
                        tooltip.style.left = (e.clientX + 15) + 'px';
                        tooltip.style.top = (e.clientY + 15) + 'px';
                        tooltip.classList.add('active');
                        tooltip.style.display = 'block';
                    }
                    document.querySelectorAll('.pal-cell').forEach(cell => {
                        cell.classList.toggle('picker-highlight', parseInt(cell.dataset.idx) === foundIdx);
                    });
                } else {
                    if (!state.showGameGrid) {
                        if (tooltip) {
                            tooltip.classList.remove('active');
                            tooltip.style.display = 'none';
                        }
                    }
                    document.querySelectorAll('.pal-cell').forEach(cell => cell.classList.remove('picker-highlight'));
                }
            }
        } else if (!state.showGameGrid) {
            if (tooltip) {
                tooltip.classList.remove('active');
                tooltip.style.display = 'none';
            }
            document.querySelectorAll('.pal-cell').forEach(cell => cell.classList.remove('picker-highlight'));
        }

        // Drawing/Selection disabled in TMP Editor
        // renderOverlay(x, y, activeTool, null);

        if (isDraggingTiles) {
            const dx = x - lastDragTilesPos.x;
            const dy = y - lastDragTilesPos.y;
            if (dx !== 0 || dy !== 0) {
                if (state.bondSelection) {
                    const selected = Array.from(state.tileSelection);
                    for (const idx of selected) {
                        moveTileBy(idx, dx, dy, true);
                    }
                } else {
                    for (const key of state.subSelection) {
                        const [idxStr, subType] = key.split('_');
                        const idx = parseInt(idxStr);
                        if (subType === 'base') {
                            moveTileBy(idx, dx, dy, false);
                        } else if (subType === 'extra') {
                            moveExtraBy(idx, dx, dy);
                        }
                    }
                }
                lastDragTilesPos = { x, y };
                recomputeWorldBoundsFromState();
                renderCanvas();
                updateTileProperties();
            }
            return;
        }
    });

    const workspace = elements.canvasScrollArea || elements.canvasArea;
    if (workspace) {
        workspace.addEventListener('mousedown', (e) => {
            if (e.target !== elements.mainCanvas && e.target !== elements.overlayCanvas && e.target !== workspace && e.target !== elements.canvasWrapper && e.target !== elements.pixelGridOverlay && e.target.id !== 'canvasResizePreview' && e.target.tagName !== 'CANVAS' && e.target !== elements.canvasArea) {
                return; // Clicking on dialogs or scrollbars
            }
            document.querySelectorAll('.pal-cell').forEach(cell => cell.classList.remove('picker-highlight'));
        });
        workspace.addEventListener('mouseleave', () => {
            const tooltip = document.getElementById('uiTooltip');
            if (tooltip) {
                tooltip.classList.remove('active');
                tooltip.style.display = 'none';
            }
            // Clear pixel coordinates when leaving the canvas area
            if (elements.coordsDisplay) elements.coordsDisplay.innerText = '';
            document.querySelectorAll('.pal-cell').forEach(cell => cell.classList.remove('picker-highlight'));
        });
    }

    window.onmouseup = (e) => {
        stopSpraying();

        const { x, y } = getPos(e);
        state.currentX = x;
        state.currentY = y;

        if (isDraggingTiles) {
            isDraggingTiles = false;
            dragTilesStart = null;
            lastDragTilesPos = null;
            return;
        }

        if (!isDrawing) return;

        // Handle Moving Selection (Pixels or Area), Scaling or Rotating
        if (state.isMovingSelection || state.isMovingSelectionArea || state.isScalingSelection || state.isRotatingSelection) {
            let hasChanged = false;

            // Check if actual movement/scaling/rotating occurred
            if (state.isScalingSelection || state.isRotatingSelection) {
                hasChanged = true;
            } else if ((state.isMovingSelection || state.isMovingSelectionArea) && state.dragStartFloating && state.selection) {
                if (state.selection.x !== state.dragStartFloating.x || state.selection.y !== state.dragStartFloating.y) {
                    hasChanged = true;
                }
            }

            if (state.isRotatingSelection && state.floatingSelection) {
                // Commit the rotation to originalData so future scales/rotates build on this
                const fs = state.floatingSelection;
                fs.originalData = new Uint8Array(fs.data);
                fs.originalW = fs.w;
                fs.originalH = fs.h;
                if (fs.maskData) {
                    fs.originalMaskData = new Uint8Array(fs.maskData);
                }
            } else if (state.isScalingSelection && state.floatingSelection) {
                // Commit scale to originalData
                const fs = state.floatingSelection;
                fs.originalData = new Uint8Array(fs.data);
                fs.originalW = fs.w;
                fs.originalH = fs.h;
                if (fs.maskData) {
                    fs.originalMaskData = new Uint8Array(fs.maskData);
                }
            }

            state.isMovingSelection = false;
            state.isMovingSelectionArea = false;
            state.isScalingSelection = false;
            state.isRotatingSelection = false;
            state.scaleHandleIdx = null;
            state.rotationStartAngle = 0;
            state.rotationBaseAngle = 0;
            state.dragStart = null;
            state.dragStartFloating = null;
            setIsDrawing(false);
            if (hasChanged) {
                pushHistory(); // Capture the new position, scale, or rotation
            }
            updateTilesList();
            updateTilesList();
            return;
        }

        if (!isDrawing) return;

        // Handle Finishing Selection (Rectangle or Lasso)
        if (state.isSelecting) {
            state.isSelecting = false;
            const { x, y } = getPos(e);

            if (activeTool === 'select') {
                const sx = state.startSel.x;
                const sy = state.startSel.y;
                const w = x - sx;
                const h = y - sy;
                const wasCtrlHeld = state.ctrlHeld;
                state.ctrlHeld = false; // Reset

                // Threshold to differentiate between click and marquee
                const dist = Math.sqrt(w * w + h * h);
                if (dist < 4) {
                    selectTileAt(sx, sy, wasCtrlHeld, state.shiftHeld);
                } else {
                    selectTilesInRect(sx, sy, x, y, wasCtrlHeld);
                }

                state.isSelecting = false;
                state.startSel = null;
                renderOverlay();

            } else if (activeTool === 'lasso') {
                const wasCtrlHeld = state.ctrlHeld;
                state.ctrlHeld = false;

                if (state.startSel.length < 3) {
                    if (wasCtrlHeld && state.startSel.length === 1) {
                        const { x, y } = state.startSel[0];
                        togglePixelSelection(x, y);
                        if (state.selection) startAnts();
                        renderCanvas();
                        return;
                    }

                    const points = state.startSel;
                    const w = state.canvasW;
                    const h = state.canvasH;
                    const pixels = new Set();
                    for (let i = 0; i < points.length; i++) {
                        const p1 = points[i];
                        const p2 = points[(i + 1) % points.length];
                        const line = bresenham(p1.x, p1.y, p2.x, p2.y);
                        line.forEach(p => pixels.add(p.y * w + p.x));
                    }

                    if (pixels.size === 0) {
                        state.selection = null;
                        stopAnts();
                        renderCanvas();
                        renderOverlay();
                        return;
                    }

                    let minX = w, maxX = -1, minY = h, maxY = -1;
                    pixels.forEach(idx => {
                        const x = idx % w;
                        const y = Math.floor(idx / w);
                        if (x < minX) minX = x; if (x > maxX) maxX = x;
                        if (y < minY) minY = y; if (y > maxY) maxY = y;
                    });

                    const rw = maxX - minX + 1;
                    const rh = maxY - minY + 1;
                    const maskData = new Uint8Array(rw * rh);
                    pixels.forEach(idx => {
                        const x = idx % w;
                        const y = Math.floor(idx / w);
                        maskData[(y - minY) * rw + (x - minX)] = 1;
                    });

                    const newSel = { type: 'mask', x: minX, y: minY, w: rw, h: rh, maskData };
                    const effectiveMode = wasCtrlHeld ? 'add' : state.selectionMode;

                    if (effectiveMode === 'new' || !state.selection) {
                        state.selection = newSel;
                    } else {
                        state.selection = combineSelection(state.selection, newSel, effectiveMode);
                    }

                    startAnts();
                    renderCanvas();
                    renderOverlay();
                    state.startSel = null;
                    return;
                }

                const originalMode = state.selectionMode;
                if (wasCtrlHeld) state.selectionMode = 'add';
                finishLassoSelection();
                if (wasCtrlHeld) state.selectionMode = originalMode;

                if (state.selection) startAnts();
                renderCanvas();
                renderOverlay();
            }
            state.startSel = null;
            setIsDrawing(false);
            return;
        }

        // Update sidebar thumbnails if something was drawn
        // Use a local flag or check before resetting state
        // Update sidebar thumbnails if something was drawn
        if (isDrawing) {
            try { updateTilesList(); } catch (e) { console.error("Layers update failed", e); }
            try { updateTilesList(); } catch (e) { console.error("Frames list update failed", e); }
        }
        setIsDrawing(false);
        updateUIState();
    };

    // Frames controls
    // Tiles Controls
    if (elements.btnAddTile) elements.btnAddTile.onclick = () => addTile();
    if (elements.btnNewExtra) elements.btnNewExtra.onclick = () => createExtraDataForSelected();
    if (elements.btnDuplicateTile) elements.btnDuplicateTile.onclick = () => {
        pushHistory();
        const selected = Array.from(state.tileSelection).sort((a, b) => a - b);
        const newTiles = [];
        for (const idx of selected) {
            const t = state.tiles[idx];
            newTiles.push({
                ...t, id: generateId(),
                data: new Uint8Array(t.data),
                extraImageData: t.extraImageData ? new Uint8Array(t.extraImageData) : null,
                _v: (t._v || 0) + 1
            });
        }
        const insertAt = selected.length > 0 ? selected[selected.length - 1] + 1 : state.tiles.length;
        state.tiles.splice(insertAt, 0, ...newTiles);

        // Update selection to new tiles
        state.tileSelection.clear();
        for (let i = 0; i < newTiles.length; i++) state.tileSelection.add(insertAt + i);
        state.currentTileIdx = insertAt;

        updateTilesList();
        renderCanvas();
    };
    if (elements.btnDeleteTile) elements.btnDeleteTile.onclick = () => deleteSelectedTiles();
    if (elements.btnMoveTilesUp) elements.btnMoveTilesUp.onclick = () => moveSelectedTilesUp();
    if (elements.btnMoveTilesDown) elements.btnMoveTilesDown.onclick = () => moveSelectedTilesDown();

    // Play button removed

    // Clear overlay on mouse out
    if (elements.canvasArea) {
        if (elements.canvasArea) elements.canvasArea.addEventListener('mouseout', () => {
            stopSpraying();
            renderOverlay(undefined, undefined, null, null);
        });
    }

    window.addEventListener('blur', stopSpraying);

    // --- SIDE PANEL EXTRA TOGGLE ---
    // --- GLOBAL TOOLTIP SYSTEM ---
    // `#pixelTooltip` logic was here, removed to unify with `ui.js` system.

    // --- SIDE PANEL EXTRA TOGGLE ---


    // --- ZOOM CONTROLS ---
    // Selection Tools actions



    if (elements.btnZoomMinus) {
        setupAutoRepeat(elements.btnZoomMinus, (ev) => {
            let val = parseInt(elements.inpZoom.value);
            if (ev && ev.ctrlKey) {
                val = val - 5;
            } else {
                if (val <= 100) val = 50;
                else val = Math.ceil(val / 100) * 100 - 100;
            }
            const min = parseInt(elements.inpZoom.min || 50);
            if (elements.inpZoom) elements.inpZoom.value = Math.max(min, val);
            if (elements.inpZoom) elements.inpZoom.dispatchEvent(new Event('input'));
        });
    }

    if (elements.btnZoomPlus) {
        setupAutoRepeat(elements.btnZoomPlus, (ev) => {
            let val = parseInt(elements.inpZoom.value);
            if (ev && ev.ctrlKey) {
                val = val + 5;
            } else {
                if (val < 100) val = 100;
                else val = Math.floor(val / 100) * 100 + 100;
            }
            const max = parseInt(elements.inpZoom.max || 5000);
            if (elements.inpZoom) elements.inpZoom.value = Math.min(max, val);
            if (elements.inpZoom) elements.inpZoom.dispatchEvent(new Event('input'));
        });
    }

    if (elements.btnToggleGrid) {
        if (elements.btnToggleGrid) elements.btnToggleGrid.onclick = () => {
            state.showGrid = !state.showGrid;
            elements.btnToggleGrid.classList.toggle('active', state.showGrid);
            updatePixelGrid();
        };
        // Initial sync
        elements.btnToggleGrid.classList.toggle('active', state.showGrid);
    }

    // Toggle Background
    const btnToggleBg = document.getElementById('btnToggleBg');
    if (btnToggleBg) {
        btnToggleBg.onclick = () => {
            state.showBackground = !state.showBackground;
            btnToggleBg.classList.toggle('active', state.showBackground);
            renderCanvas();
        };
        // Initial sync
        btnToggleBg.classList.toggle('active', state.showBackground);
    }

    // Game Grid (Automated TS/RA2)
    const btnToggleGameGrid = document.getElementById('btnToggleGameGrid');
    if (btnToggleGameGrid) {
        btnToggleGameGrid.onclick = () => {
             state.showGameGrid = !state.showGameGrid;
             recomputeWorldBoundsFromState(); // Force dimension update for background and grid
             renderCanvas();
             syncMenuToggles();
        };
    }
}

function parseColorRef(str) {
    if (!str) return null;
    str = str.trim();
    // Index? Ensure it's ONLY a number
    if (/^\d+$/.test(str)) {
        const idx = parseInt(str);
        if (idx >= 0 && idx <= 255) {
            const c = state.palette[idx];
            if (c) return { r: c.r, g: c.g, b: c.b, idx: idx };
            // Even if color is null in palette, we might allow the index? 
            // Better to return the index.
            return { r: 0, g: 0, b: 0, idx: idx };
        }
    }
    return null;
}


function handleConfirmImport(impTmpData, impTmpPalette) {
    if (!impTmpData) return;

    // 1. Sync Palette
    if (impTmpPalette) {
        state.palette = impTmpPalette.map(c => c ? { ...c } : null);
        state.paletteVersion++;
        renderPalette();
    }

    // 2. Use Native Loader
    loadTmpData(impTmpData);

    // 2.5 Update Tab Name
    if (impTmpData.filename) {
        updateCurrentTabName(impTmpData.filename);
    }

    // 3. Update UI
    pushHistory("all");
    state.savedHistoryPtr = state.historyPtr; // Mark this state as saved
    state.hasChanges = false;

    // 4. Save to Recent Files (if FSAPI handle available)
    if (window._lastTmpFileHandle && impTmpData.filename) {
        saveRecentFile(impTmpData.filename, window._lastTmpFileHandle);
    }

    // Update UI element visibility
    updateUIState();
}

async function openNewTmpDialog() {
    const dialog = document.getElementById('newTmpDialog');
    if (!dialog) return;

    // If there ARE changes, ask first
    if (state.hasChanges && state.tmpData) {
        const confirmed = await showConfirm(t('dlg_confirm_title'), t('msg_confirm_close_tab') || "Are you sure? Any unsaved changes will be lost.");
        if (!confirmed) return;
    }

    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
}

async function openOpenTmpDialog() {
    const dialog = document.getElementById('importTmpDialog');
    if (!dialog) return;

    // If there ARE changes, ask first
    if (state.hasChanges && state.tmpData) {
        const confirmed = await showConfirm(t('dlg_confirm_title'), t('msg_confirm_close_tab') || "Are you sure? Any unsaved changes will be lost.");
        if (!confirmed) return;
    }

    if (typeof resetImportState === 'function') resetImportState();
    if (typeof syncImporterPalette === 'function') syncImporterPalette(state.palette);
    
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
}

function initNewTmpDialog() {
    const dialog = document.getElementById('newTmpDialog');
    const btnCancel = document.getElementById('btnCancelNewTmp');
    const btnCreate = document.getElementById('btnCreateNewTmp');

    if (!dialog) return;

    const close = () => {
        if (typeof updateUIState === 'function') updateUIState();
        if (typeof dialog.close === 'function') dialog.close();
        else dialog.removeAttribute('open');
    };

    // EXPOSE UTILS FOR CONTEXT MENU
    window._uiUtils = { getPos, pickTileIndexAt, selectTileAt };

    if (btnCancel) btnCancel.onclick = close;

    if (btnCreate) {
        btnCreate.onclick = async () => {
            const bx = parseInt(document.getElementById('newTmpBlocksX').value) || 1;
            const by = parseInt(document.getElementById('newTmpBlocksY').value) || 1;
            const profile = document.querySelector('input[name="newTmpProfile"]:checked')?.value || 'ra2';

            const tileW = profile === 'ra2' ? 60 : 48;
            const tileH = profile === 'ra2' ? 30 : 24;

            const totalW = bx * tileW;
            const totalH = by * tileH;

            const confirmed = true;
            // Redundant confirmation removed because it opens in a new tab now

            if (confirmed) {
                // Update global state immediately before creation
                const isTS = (profile === 'ts');
                state.cx = tileW;
                state.cy = tileH;
                state.gameType = isTS ? 'ts' : 'ra2';

                const finalPal = state.palette && state.palette.length === 256 ? state.palette.map(c => c ? { ...c } : null) : null;

                createNewProject(tileW, tileH, finalPal, 3, true);

                state.tmpData = {
                    header: {
                        cblocks_x: bx,
                        cblocks_y: by,
                        cx: tileW,
                        cy: tileH
                    },
                    tiles: Array(bx * by).fill(null)
                };

                // Populate state.tiles with default tiles for the whole grid (bx * by)
                state.tiles = [];
                const halfCx = tileW / 2;
                const halfCy = tileH / 2;
                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                for (let i = 0; i < bx * by; i++) {
                    const gx = i % bx;
                    const gy = Math.floor(i / bx);
                    const tx = halfCx * (gx - gy);
                    const ty = halfCy * (gx + gy);
                    minX = Math.min(minX, tx); minY = Math.min(minY, ty);
                    maxX = Math.max(maxX, tx + tileW); maxY = Math.max(maxY, ty + tileH);
                    state.tiles.push({
                        id: generateId(),
                        width: tileW, height: tileH,
                        itemMinX: tx, itemMinY: ty,
                        data: new Uint8Array(tileW * tileH).fill(0),
                        zData: TmpTsFile.decodeTileDiamond(TmpTsFile.generateDefaultZData(tileW, tileH), tileW, tileH),
                        tileHeader: {
                            x: tx, y: ty, extra_ofs: 0, z_ofs: 0, extra_z_ofs: 0,
                            x_extra: 0, y_extra: 0, cx_extra: 0, cy_extra: 0,
                            flags: 2, height: 0, land_type: 0, ramp_type: 0,
                            has_z_data: true, has_extra_data: false, has_damaged_data: false,
                            radar_red_left: 128, radar_green_left: 128, radar_blue_left: 128,
                            radar_red_right: 128, radar_green_right: 128, radar_blue_right: 128
                        },
                        visible: true, _v: 0
                    });
                }
                state.canvasW = Math.ceil(maxX - minX);
                state.canvasH = Math.ceil(maxY - minY);
                state.worldBounds = { minX, minY, maxX, maxY, width: state.canvasW, height: state.canvasH, hasTiles: true };
                state.currentTileIdx = 0;
                state.tileSelection.clear();
                state.tileSelection.add(0);

                state.newFileCounter++;
                updateCurrentTabName(`New File ${state.newFileCounter}`, true);

                // SYNC STATE TO TAB IMMEDIATELY
                if (state.activeTabIndex !== -1) {
                    state.saveToTab(state.tabs[state.activeTabIndex]);
                }

                // Initial history state for the whole grid
                state.history = [];
                state.historyPtr = -1;
                pushHistory('all', true);
                state.savedHistoryPtr = state.historyPtr; // Mark initial state as saved
                state.hasChanges = false;

                updateCanvasSize();
                updateTilesList();
                renderTabs();
                renderCanvas();
                updateExtraBtnState();
                close();
                showEditorInterface();
            }
        };
    }
}

window.addEventListener('paste', async (e) => {
    // Only handle image paste if we are not in an input
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;

    // We check the system clipboard for our "Internal Marker":
    let isInternal = false;
    if (e.clipboardData) {
        if (e.clipboardData.types.includes('text/plain')) {
            if (e.clipboardData.getData('text/plain') === '__TMP_TILES_DATA__') isInternal = true;
        }
        if (!isInternal && e.clipboardData.types.includes('text/html')) {
            if (e.clipboardData.getData('text/html').includes('__TMP_TILES_DATA__')) isInternal = true;
        }
    }

    if (isInternal) {
        const internalTiles = localStorage.getItem('tmp_tile_clipboard');
        if (internalTiles) {
            e.preventDefault();
            let mode = 'full';
            try {
                const parsed = JSON.parse(internalTiles);
                if (parsed.metadata && parsed.metadata.mode) {
                    mode = parsed.metadata.mode;
                }
            } catch (err) {}
            pasteTiles(e.shiftKey, mode, true);
            return;
        }
    }

    let hasImage = false;
    if (e.clipboardData && e.clipboardData.items) {
        for (const item of e.clipboardData.items) {
            if (item.type.indexOf('image') !== -1) {
                const imgBlob = item.getAsFile();
                if (imgBlob) {
                    hasImage = true;
                    e.preventDefault();
                    
                    const pasteSettings = window.pendingSystemPaste || { 
                        mode: state.tileSelection?.size > 0 ? 'img_merged' : 'img_total', 
                        isForced: state.tileSelection?.size > 0 
                    };
                    window.pendingSystemPaste = null; // Clear it

                    if (window.processSystemImagePaste) {
                        window.processSystemImagePaste(imgBlob, pasteSettings.mode, pasteSettings.isForced);
                    }
                    break;
                }
            }
        }
    }
    
    // Fallback to traditional tile paste
    if (!hasImage) {
        pasteTiles(e.shiftKey, 'full');
    }
});

window.onload = init;

function setupColorShiftUIListeners() {
    if (!elements.btnColorShiftPlus) return;

    if (elements.btnColorShiftPlus) elements.btnColorShiftPlus.onclick = () => shiftColorIndex(state.toolSettings.colorShiftAmount);
    if (elements.btnColorShiftMinus) elements.btnColorShiftMinus.onclick = () => shiftColorIndex(-state.toolSettings.colorShiftAmount);

    if (elements.colorShiftAmount) {
        if (elements.colorShiftAmount) elements.colorShiftAmount.oninput = (e) => {
            const val = parseInt(e.target.value);
            state.toolSettings.colorShiftAmount = val;
            if (elements.colorShiftAmtVal) elements.colorShiftAmtVal.innerText = val;
            if (elements.colorShiftBar) elements.colorShiftBar.style.width = (val / 10 * 100) + '%';
        };
    }

    if (elements.btnColorShiftAmtMinus) {
        setupAutoRepeat(elements.btnColorShiftAmtMinus, (ev) => {
            const step = (ev && ev.ctrlKey) ? 5 : 1;
            const val = Math.max(1, state.toolSettings.colorShiftAmount - step);
            state.toolSettings.colorShiftAmount = val;
            if (elements.colorShiftAmount) elements.colorShiftAmount.value = val;
            if (elements.colorShiftAmtVal) elements.colorShiftAmtVal.innerText = val;
            if (elements.colorShiftBar) elements.colorShiftBar.style.width = (val / 10 * 100) + '%';
        });
    }

    if (elements.btnColorShiftAmtPlus) {
        setupAutoRepeat(elements.btnColorShiftAmtPlus, (ev) => {
            const step = (ev && ev.ctrlKey) ? 5 : 1;
            const val = Math.min(10, state.toolSettings.colorShiftAmount + step);
            state.toolSettings.colorShiftAmount = val;
            if (elements.colorShiftAmount) elements.colorShiftAmount.value = val;
            if (elements.colorShiftAmtVal) elements.colorShiftAmtVal.innerText = val;
            if (elements.colorShiftBar) elements.colorShiftBar.style.width = (val / 10 * 100) + '%';
        });
    }

    if (elements.radColorShiftScope) {
        if (elements.radColorShiftScope) elements.radColorShiftScope.forEach(rad => {
            rad.onchange = (e) => {
                state.toolSettings.colorShiftScope = e.target.value;
            };
        });
    }

    if (elements.chkIgnoreColor0) {
        if (elements.chkIgnoreColor0) elements.chkIgnoreColor0.onchange = (e) => {
            state.toolSettings.ignoreColor0 = e.target.checked;
        };
    }

    if (elements.chkCycleShiftPalette) {
        if (elements.chkCycleShiftPalette) elements.chkCycleShiftPalette.onchange = (e) => {
            state.toolSettings.cycleShiftPalette = e.target.checked;
        };
    }
}

// Global zoom prevention (Ctrl+Wheel and Ctrl++/Ctrl+-)
window.addEventListener('wheel', (e) => {
    if (e.ctrlKey) {
        e.preventDefault();
    }
}, { passive: false });

window.addEventListener('keydown', (e) => {
    if (!e.key) return;
    const k = e.key.toLowerCase();
    if (e.ctrlKey && (k === '+' || k === '=' || k === '-' || k === '0')) {
        // We still allow Ctrl+0 via our main shortcut listener so it triggers the "Center" button,
        // but this stops the browser's native zoom reset.
        e.preventDefault();
    }
}, { capture: true, passive: false });

// --- DRAG AND DROP HANDLERS ---
function showsDrop() {
    const dz = elements.dropZoneOverlay;
    if (dz) {
        dz.style.display = 'flex';
        // Small delay to ensure display is applied before opacity for transition (if any)
        requestAnimationFrame(() => {
            dz.style.opacity = '1';
            dz.style.visibility = 'visible';
        });
    }
}

function hidesDrop() {
    const dz = elements.dropZoneOverlay;
    if (dz) {
        dz.style.opacity = '0';
        dz.style.visibility = 'hidden';
        // After transition (0.3s as defined in index.html), set display none
        setTimeout(() => {
            if (dz.style.opacity === '0') dz.style.display = 'none';
        }, 300);
    }
}

document.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer.types && e.dataTransfer.types.includes('Files')) {
        showsDrop();
    }
});

document.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (e.dataTransfer.types && e.dataTransfer.types.includes('Files')) {
        showsDrop();
    }
});

document.addEventListener('dragleave', (e) => {
    e.preventDefault();
    // Only hide if we are truly leaving the body
    if (e.target === document.documentElement || e.target === document.body || e.relatedTarget === null) {
        hidesDrop();
    }
});

export async function processSystemFileOpen(file, handle = null) {
    try {
        const buffer = await file.arrayBuffer();
        const tmpData = TmpTsFile.parse(buffer);

        // SUCCESS: Open in a new tab
        if (typeof createNewTab === 'function') {
            const newTab = createNewTab();
            if (newTab && handle) {
                newTab.fileHandle = handle; // Store handle in the tab object!
            }
        }
        
        if (typeof loadTmpData === 'function') loadTmpData(tmpData);
        if (typeof updateCurrentTabName === 'function') updateCurrentTabName(handle ? handle.name : file.name);
        
        // Sync active state fileHandle from the new tab
        state.fileHandle = handle;
        state.savedHistoryPtr = state.historyPtr; 
        state.hasChanges = false;
        
        console.log(`[FileOpen] Loaded TMP: ${file.name} ${handle ? '(Direct Save Enabled)' : ''}`);
        return true;
    } catch (err) {
        console.warn(`[FileOpen] Ignoring invalid or failed file: ${file.name}`);
        return false;
    }
}

document.addEventListener('drop', async (e) => {
    e.preventDefault();
    hidesDrop();
    
    // Capture handles for "Direct Save" in Chrome/Edge if available
    const items = Array.from(e.dataTransfer.items || []);
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    // A tab is consider "discardable" if it's the only one and it's empty
    const initialTab = (state.tabs.length === 1) ? state.tabs[0] : null;
    let anyLoaded = false;

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        let handle = null;
        
        // Try getting native handle from drag data (experimental but works in Chrome/Edge)
        try {
            if (items[i] && typeof items[i].getAsFileSystemHandle === 'function') {
                handle = await items[i].getAsFileSystemHandle();
            }
        } catch (err) {
            console.warn("[Drop] Failed to get native handle for:", file.name, err);
        }

        const success = await processSystemFileOpen(file, handle);
        if (success) anyLoaded = true;
    }

    // DISCARD INITIAL EMPTY TAB
    if (anyLoaded && initialTab && (!initialTab.filename || initialTab.filename === 'New Project')) {
        setTimeout(() => {
            if (typeof closeTab === 'function') closeTab(initialTab.id);
        }, 150);
    }
});


