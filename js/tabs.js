let lastClosedTab = null;
let currentContextTabIndex = -1;

import { state, Tab, generateId } from './state.js';
import { updateUIState } from './main.js';
import { renderCanvas, updateTilesList, renderPalette, updateCanvasSize, renderOverlay, showConfirm, showChoice } from './ui.js';
import { handleSaveTmp, handleSaveAll, populateTabWithTmpData } from './file_io.js';
import { renderHistory } from './history.js';
import { t } from './translations.js';

export function initTabs() {
    const btnNewTab = document.getElementById('btnNewTab');
    const tabsContainer = document.getElementById('tabsContainer');
    const tabsDropdownBtn = document.getElementById('tabsDropdownBtn');
    const tabsDropdown = document.getElementById('tabsDropdown');
    const tabsSearchInput = document.getElementById('tabsSearchInput');
    const tabsSearchClear = document.getElementById('tabsSearchClear');
    const tabScrollLeft = document.getElementById('tabScrollLeft');
    const tabScrollRight = document.getElementById('tabScrollRight');
    const btnPrevTab = document.getElementById('btnPrevTab');
    const btnNextTab = document.getElementById('btnNextTab');
    const ctxMenu = document.getElementById('tabContextMenu');

    // Initial tab creation if empty (Truly empty)
    if (state.tabs.length === 0) {
        createNewTabAt(0, null);
    }

    btnNewTab.onclick = () => createNewTab();
    
    btnPrevTab.onclick = () => {
        if (state.activeTabIndex > 0) switchTab(state.activeTabIndex - 1);
    };
    btnNextTab.onclick = () => {
        if (state.activeTabIndex < state.tabs.length - 1) switchTab(state.activeTabIndex + 1);
    };

    tabsDropdownBtn.onclick = (e) => {
        e.stopPropagation();
        const isActive = tabsDropdown.classList.toggle('active');
        tabsDropdownBtn.classList.toggle('active', isActive);
        if (isActive) {
            tabsSearchInput.focus();
            renderTabList();
        }
    };

    tabsSearchInput.oninput = () => renderTabList();
    tabsSearchClear.onclick = () => {
        tabsSearchInput.value = '';
        renderTabList();
        tabsSearchInput.focus();
    };

    tabScrollLeft.onclick = () => tabsContainer.scrollLeft -= 200;
    tabScrollRight.onclick = () => tabsContainer.scrollLeft += 200;

    // Context Menu Actions
    document.getElementById('ctxNewTab').onclick = () => {
        createNewTabAt(currentContextTabIndex + 1);
        ctxMenu.classList.remove('active');
    };
    document.getElementById('ctxDuplicateTab').onclick = () => {
        duplicateTabAt(currentContextTabIndex);
        ctxMenu.classList.remove('active');
    };
    document.getElementById('ctxCloseOthers').onclick = () => {
        closeOtherTabs(currentContextTabIndex);
        ctxMenu.classList.remove('active');
    };
    const ctxCloseAll = document.getElementById('ctxCloseAll');
    if (ctxCloseAll) {
        ctxCloseAll.onclick = () => {
            closeAllTabs();
            ctxMenu.classList.remove('active');
        };
    }
    document.getElementById('ctxCloseTab').onclick = () => {
        closeTab(currentContextTabIndex);
        ctxMenu.classList.remove('active');
    };
    document.getElementById('ctxReopenTab').onclick = () => {
        reopenLastTab();
        ctxMenu.classList.remove('active');
    };

    document.addEventListener('click', (e) => {
        if (tabsDropdown && tabsDropdown.classList.contains('active') && !tabsDropdown.contains(e.target) && e.target !== tabsDropdownBtn) {
            tabsDropdown.classList.remove('active');
            tabsDropdownBtn.classList.remove('active');
        }
        if (ctxMenu) ctxMenu.classList.remove('active');
    });

    // Scroll interactivity
    const updateScrollButtons = () => {
        requestAnimationFrame(() => {
            const hasOverflow = tabsContainer.scrollWidth > tabsContainer.clientWidth;
            tabScrollLeft.classList.toggle('active', hasOverflow);
            tabScrollRight.classList.toggle('active', hasOverflow);
        });
    };
    
    new ResizeObserver(updateScrollButtons).observe(tabsContainer);
    
    // Wheel to scroll tabs horizontally
    tabsContainer.addEventListener('wheel', (e) => {
        e.preventDefault();
        tabsContainer.scrollLeft += e.deltaY;
    }, { passive: false });

    // Component initialization
    window.renderTabs = renderTabs;
    window.updateCurrentTabName = updateCurrentTabName;
    window.closeTab = closeTab;
    window.closeAllTabs = closeAllTabs;
    renderTabs();
}

export function createNewTab(fileName = null) {
    return createNewTabAt(state.tabs.length, fileName);
}

export function createBackgroundTabForFile(entry) {
    const { file, handle, filePath, tmpData, mtime } = entry;
    const fn = filePath ? filePath.split(/[/\\]/).pop() : (handle ? handle.name : file.name);
    const tab = new Tab(generateId(), fn, state);
    tab.idName = fn;
    tab.fileName = fn;
    tab.isNewProject = false;
    tab.filePath = filePath || null;
    tab.fileHandle = handle || null;
    tab.fileLastModified = mtime || 0;
    tab.hasChanges = false;
    tab.history = [];
    tab.historyPtr = -1;
    tab.savedHistoryPtr = -1;

    if (filePath && tmpData) tmpData.filePath = filePath;
    populateTabWithTmpData(tab, tmpData, fn);
    return tab;
}

function createNewTabAt(index, fileName = null, shouldSwitch = true) {
    const id = generateId();
    const name = fileName || "";
    const tab = new Tab(id, fileName, state);
    tab.idName = name;
    
    // Truly empty tab by default. Tiles/tmpData are only populated 
    // when a file is loaded or a New TMP project is created via dialog.
    
    if (shouldSwitch) {
        if (state._currentLoadedTab) {
            state.saveToTab(state._currentLoadedTab);
        } else if (state.activeTabIndex !== -1 && state.tabs[state.activeTabIndex]) {
            state.saveToTab(state.tabs[state.activeTabIndex]);
        }
    }

    if (!shouldSwitch && state.activeTabIndex >= index) {
        state.activeTabIndex++;
    }

    state.tabs.splice(index, 0, tab);
    if (shouldSwitch) {
        switchTab(index);
    }
    return tab;
}

function duplicateTabAt(index) {
    const source = state.tabs[index];
    if (index === state.activeTabIndex || state._currentLoadedTab === source) {
        state.saveToTab(source);
    }

    // Deep clone using structuredClone (handles Sets, TypedArrays, etc.)
    const clone = structuredClone(source);
    clone.id = generateId();
    clone.fileName = null;
    clone.fileHandle = null;
    clone.filePath = null;
    clone.fileLastModified = 0;
    clone.hasChanges = true;
    clone.isNewProject = true;
    clone.idName = source.idName ? `${source.idName} (Copy)` : `New File ${++state.newFileCounter}`;
    
    const insertIdx = index + 1;
    if (state.activeTabIndex >= insertIdx) {
        state.activeTabIndex++;
    }
    state.tabs.splice(insertIdx, 0, clone);
    switchTab(insertIdx);
}

async function closeOtherTabs(keptIndex) {
    const others = state.tabs
        .map((tab, idx) => ({ tab, idx }))
        .filter(({ idx }) => idx !== keptIndex);

    for (const { tab, idx } of others) {
        if (!tab.hasChanges) continue;

        const tabName = tab.fileName || tab.idName || (tab.tmpData?.filename) || `Tab ${idx + 1}`;
        const answer = await showChoice(
            t('dlg_close_tab_title'),
            t('msg_confirm_close_single_unsaved').replace('{name}', tabName),
            t('btn_save_and_close'),
            t('btn_discard_and_close')
        );
        if (answer === 'cancel') {
            return;
        }
        if (answer === 'opt1') {
            try {
                const previousActive = state.activeTabIndex;
                state.activeTabIndex = idx;
                state.loadFromTab(tab);

                await handleSaveTmp();
                const saveOk = !state.hasChanges;
                state.saveToTab(tab);
                if (previousActive !== idx) {
                    state.activeTabIndex = previousActive;
                    state.loadFromTab(state.tabs[previousActive]);
                }
                if (!saveOk) {
                    console.warn('[closeOtherTabs] Save was cancelled for', tabName);
                    return;
                }
            } catch (e) {
                console.warn('[closeOtherTabs] Save failed for', tabName, e);
                return;
            }
        }
    }

    const kept = state.tabs[keptIndex];
    if (state.activeTabIndex >= 0 && state.activeTabIndex < state.tabs.length) {
        const activeTab = state._currentLoadedTab || state.tabs[state.activeTabIndex];
        if (activeTab !== kept) {
            state.saveToTab(activeTab);
        }
    }
    state.tabs = [kept];
    state.activeTabIndex = 0;
    state.loadFromTab(kept);
    renderTabs();
    updateUIState();
    updateCanvasSize();
    renderCanvas();
    renderOverlay();
    updateTilesList();
    renderPalette();
    renderHistory();
}

function reopenLastTab() {
    if (!lastClosedTab) return;
    state.tabs.push(lastClosedTab);
    lastClosedTab = null;
    switchTab(state.tabs.length - 1);
}

export function switchTab(index) {
    if (index < 0 || index >= state.tabs.length) return;

    // Persist current state before switching
    const currentTab = state._currentLoadedTab || (state.activeTabIndex !== -1 ? state.tabs[state.activeTabIndex] : null);
    if (currentTab && state.tabs[index] !== currentTab) {
        state.saveToTab(currentTab);
    }

    state.activeTabIndex = index;
    const newTab = state.tabs[index];
    state.loadFromTab(newTab);

    // Synchronize file handles and filenames with active tab
    state.fileHandle = newTab.fileHandle || null;
    state.filePath = newTab.filePath || null;
    state.fileLastModified = newTab.fileLastModified || 0;
    window._lastTmpFileHandle = newTab.fileHandle || null;
    window._lastTmpFilePath = newTab.filePath || null;
    window._lastTmpFilename = newTab.fileName || null;

    // UI Refresh
    renderTabs();
    updateUIState();
    updateCanvasSize();
    renderCanvas();
    renderOverlay();
    updateTilesList();
    renderPalette();
    renderHistory();

    // Active tab visibility adjustment
    setTimeout(() => {
        const activeTabEl = document.querySelector('.chrome-tab.active');
        if (activeTabEl) activeTabEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }, 50);
}

function resetToCleanDefaultTab(preservePaletteFromTab = null) {
    const cleanTab = new Tab(generateId(), null, preservePaletteFromTab || state.tabs[0] || null);
    state.newFileCounter = 1;
    cleanTab.idName = 'New File 1';
    cleanTab.fileName = null;
    cleanTab.isNewProject = true;
    cleanTab.hasChanges = false;
    cleanTab.tmpData = null;
    cleanTab.tiles = [];
    cleanTab.fileHandle = null;
    cleanTab.filePath = null;
    cleanTab.fileLastModified = 0;
    cleanTab.history = [];
    cleanTab.historyPtr = -1;
    cleanTab.savedHistoryPtr = -1;

    state.tabs = [cleanTab];
    state.activeTabIndex = 0;

    // Reset global state explicitly
    state.fileHandle = null;
    state.filePath = null;
    state.fileLastModified = 0;
    window._lastTmpFileHandle = null;
    window._lastTmpFilePath = null;
    window._lastTmpFilename = null;
    state.tmpData = null;
    state.tiles = [];
    state.currentTileIdx = -1;
    state.tileSelection = new Set();
    state.subSelection = new Set();
    state.overlappingTiles = new Set();
    state.history = [];
    state.historyPtr = -1;
    state.savedHistoryPtr = -1;
    state.hasChanges = false;

    state.loadFromTab(cleanTab);

    renderTabs();
    updateUIState();
    updateCanvasSize();
    renderCanvas();
    renderOverlay();
    updateTilesList();
    renderPalette();
    renderHistory();
}

export async function closeAllTabs() {
    // Sync active tab state
    if (state.activeTabIndex >= 0 && state.tabs[state.activeTabIndex]) {
        state.saveToTab(state.tabs[state.activeTabIndex]);
    }

    const totalCount = state.tabs.length;
    const firstTab = state.tabs[0];
    const hasFirstData = (state.activeTabIndex === 0)
        ? (!!state.tmpData || !!firstTab.tmpData)
        : !!firstTab.tmpData;

    // If only one empty and unmodified tab, nothing to close
    if (totalCount === 1 && !hasFirstData && !firstTab.hasChanges && !firstTab.isNewProject) {
        return;
    }

    const unsavedTabs = state.tabs.filter(t => t.hasChanges);

    if (unsavedTabs.length > 0) {
        const choice = await showChoice(
            t('dlg_close_all_title'),
            t('msg_confirm_close_all_unsaved').replace('{count}', totalCount).replace('{unsaved}', unsavedTabs.length),
            t('btn_save_and_close'),
            t('btn_discard_and_close')
        );

        if (choice === 'cancel') return;

        if (choice === 'opt1') {
            if (typeof handleSaveAll === 'function') {
                await handleSaveAll();
                const remainingUnsaved = state.tabs.filter(t => t.hasChanges);
                if (remainingUnsaved.length > 0) {
                    return; // User cancelled saving
                }
            }
        }
    } else {
        const confirmed = await showConfirm(
            t('dlg_close_all_title'),
            t('msg_confirm_close_all_clean').replace('{count}', totalCount)
        );
        if (!confirmed) return;
    }

    resetToCleanDefaultTab();
}

export async function closeTab(index, e) {
    if (e) e.stopPropagation();
    
    // Ensure current tab state is saved
    if (index === state.activeTabIndex && state.tabs[index]) {
        state.saveToTab(state.tabs[index]);
    }

    const tab = state.tabs[index];
    if (!tab) return;

    if (tab.hasChanges) {
        const tabName = tab.fileName || tab.idName || (tab.tmpData?.filename) || `Tab ${index + 1}`;
        const choice = await showChoice(
            t('dlg_close_tab_title'),
            t('msg_confirm_close_single_unsaved').replace('{name}', tabName),
            t('btn_save_and_close'),
            t('btn_discard_and_close')
        );
        if (choice === 'cancel') return;

        if (choice === 'opt1') {
            const previousActive = state.activeTabIndex;
            if (state.activeTabIndex !== index) {
                state.activeTabIndex = index;
                state.loadFromTab(tab);
            }
            await handleSaveTmp();
            const saveOk = !state.hasChanges;
            state.saveToTab(tab);
            if (!saveOk) {
                if (previousActive !== index) {
                    state.activeTabIndex = previousActive;
                    state.loadFromTab(state.tabs[previousActive]);
                }
                return;
            }
        }
    }

    // Save for reopen logic
    lastClosedTab = structuredClone(tab);

    if (state.tabs.length <= 1) {
        resetToCleanDefaultTab(tab);
        return;
    }

    state.tabs.splice(index, 1);
    
    if (state.activeTabIndex >= index) {
        state.activeTabIndex = Math.max(0, state.activeTabIndex - 1);
    }
    
    // Load state for the new active tab
    const newActiveTab = state.tabs[state.activeTabIndex];
    state.loadFromTab(newActiveTab);

    renderTabs();
    updateUIState();
    updateCanvasSize();
    renderCanvas();
    renderOverlay();
    updateTilesList();
    renderPalette();
    renderHistory();
}

export function updateCurrentTabName(name, isNewProject = false) {
    if (state.activeTabIndex !== -1) {
        const tab = state.tabs[state.activeTabIndex];
        tab.fileName = name;
        tab.idName = name;
        tab.isNewProject = (tab.filePath || tab.fileHandle || state.filePath || state.fileHandle) ? false : isNewProject;
        tab.hasChanges = false;
        
        // Ensure tab object is in sync with global state after project assignment
        state.saveToTab(tab);
        renderTabs();
    }
}

function renderTabs() {
    const container = document.getElementById('tabsContainer');
    const tabBar = document.getElementById('tabBar');
    const btnNewTab = document.getElementById('btnNewTab');
    const ctxMenu = document.getElementById('tabContextMenu');
    
    // Clear only tab elements, keep #btnNewTab
    Array.from(container.querySelectorAll('.chrome-tab')).forEach(el => el.remove());

    const canClose = state.tabs.length > 1;
    tabBar.classList.toggle('single-tab', !canClose);

    const menuSaveAll = document.getElementById('menuSaveAll');
    if (menuSaveAll) {
        menuSaveAll.style.display = canClose ? 'flex' : 'none';
    }
    const menuCloseAllTmp = document.getElementById('menuCloseAllTmp');
    if (menuCloseAllTmp) {
        menuCloseAllTmp.style.display = canClose ? 'flex' : 'none';
    }

    // Hide entire bar if only one tab AND it's totally empty
    // CRITICAL: Must check live state.tmpData for the active tab
    const firstTab = state.tabs[0];
    const hasFirstData = (state.activeTabIndex === 0) ? (!!state.tmpData || !!firstTab.tmpData) : !!firstTab.tmpData;
    const isFirstNew = firstTab.isNewProject;
    
    const isOnlyOneEmpty = state.tabs.length === 1 && !hasFirstData && !isFirstNew;
    tabBar.style.display = isOnlyOneEmpty ? 'none' : 'flex';
    btnNewTab.style.display = isOnlyOneEmpty ? 'none' : 'block'; // Hide new tab button too

    state.tabs.forEach((tab, index) => {
        const tabEl = document.createElement('div');
        const isActive = index === state.activeTabIndex;
        const isDirty = isActive ? state.hasChanges : tab.hasChanges;
        const isMismatch = isActive ? state.hasMismatches : tab.hasMismatches;
        const isOverlap = (isActive ? state.overlappingTiles : tab.overlappingTiles).size > 0;
        
        const hasData = isActive ? !!state.tmpData : !!tab.tmpData;
        const isNew = tab.isNewProject;

        tabEl.className = `chrome-tab ${isActive ? 'active' : ''} ${isDirty ? 'dirty' : ''}`;
        tabEl.draggable = true;
        
        const gType = isActive ? state.gameType : tab.gameType;
        const displayName = tab.idName; 
        const suffix = gType === 'ts' ? ' (TS)' : ' (RA2)';
        const finalDisplayName = (hasData || isNew) ? `${displayName}${suffix}` : '';
        tabEl.title = finalDisplayName; 

        tabEl.innerHTML = `
            <div class="tab-status-container">
                <div class="status-mismatch" style="${isMismatch ? '' : 'display:none'}"></div>
                <div class="status-changes" style="${isDirty ? '' : 'display:none'}"></div>
                <div class="status-overlap" style="${isOverlap ? '' : 'display:none'}"></div>
            </div>
            <div class="tab-title">${finalDisplayName}</div>
            <div class="tab-close" ${!canClose ? 'style="display:none"' : ''}>&times;</div>
        `;

        tabEl.onclick = () => switchTab(index);
        tabEl.oncontextmenu = (e) => {
            e.preventDefault();
            currentContextTabIndex = index;
            ctxMenu.style.left = `${e.clientX}px`;
            ctxMenu.style.top = `${e.clientY}px`;
            ctxMenu.classList.add('active');

            // Enable/disable reopen
            const reopenItem = document.getElementById('ctxReopenTab');
            reopenItem.classList.toggle('disabled', !lastClosedTab);
        };
        tabEl.onauxclick = (e) => {
            // Middle mouse button (auxclick with button === 1) closes the tab,
            // mirroring the behavior of the "X" on the tab itself.
            if (e.button === 1) {
                e.preventDefault();
                closeTab(index, e);
            }
        };
        tabEl.querySelector('.tab-close').onclick = (e) => closeTab(index, e);
        
        // DRAG AND DROP
        tabEl.ondragstart = (e) => {
            e.dataTransfer.setData('sourceIndex', index);
            tabEl.classList.add('dragging');
        };
        tabEl.ondragover = (e) => {
            e.preventDefault();
            tabEl.classList.add('drag-over');
        };
        tabEl.ondragleave = () => tabEl.classList.remove('drag-over');
        tabEl.ondrop = (e) => {
            e.preventDefault();
            tabEl.classList.remove('drag-over');
            const sourceIndex = parseInt(e.dataTransfer.getData('sourceIndex'));
            if (sourceIndex !== index) {
                moveTab(sourceIndex, index);
            }
        };
        
        container.appendChild(tabEl);
    });
}

function moveTab(from, to) {
    const element = state.tabs.splice(from, 1)[0];
    state.tabs.splice(to, 0, element);
    
    // Update active index
    if (state.activeTabIndex === from) {
        state.activeTabIndex = to;
    } else if (from < state.activeTabIndex && to >= state.activeTabIndex) {
        state.activeTabIndex--;
    } else if (from > state.activeTabIndex && to <= state.activeTabIndex) {
        state.activeTabIndex++;
    }
    
    renderTabs();
}

function renderTabList() {
    const container = document.getElementById('tabsListContainer');
    const filter = document.getElementById('tabsSearchInput').value.toLowerCase();
    container.innerHTML = '';
    const canClose = state.tabs.length > 1;

    state.tabs.forEach((tab, index) => {
        const isActive = index === state.activeTabIndex;
        const hasData = isActive ? !!state.tmpData : !!tab.tmpData;
        const isNew = tab.isNewProject;

        // SKIP truly empty tabs (no file loaded and NOT a new project)
        if (!hasData && !isNew) return;

        const tabNameForFilter = tab.idName || "New Project";
        if (filter && !tabNameForFilter.toLowerCase().includes(filter)) return;

        const gType = isActive ? state.gameType : tab.gameType;
        const suffix = gType === 'ts' ? ' (TS)' : ' (RA2)';
        const fullTitle = `${tabNameForFilter}${suffix}`;

        const isDirty = isActive ? state.hasChanges : tab.hasChanges;
        const isMismatch = isActive ? state.hasMismatches : tab.hasMismatches;
        const isOverlap = (isActive ? state.overlappingTiles : tab.overlappingTiles).size > 0;

        const item = document.createElement('div');
        item.className = `tabs-list-item ${isActive ? 'selected' : ''} ${isDirty ? 'dirty' : ''} ${!canClose ? 'single-tab' : ''}`;
        
        item.innerHTML = `
            <div class="tabs-list-title" style="${isDirty ? 'font-weight:bold' : ''}">${fullTitle}</div>
            <div class="tabs-list-status-container">
                <div class="status-mismatch" style="${isMismatch ? '' : 'display:none'}"></div>
                <div class="status-changes" style="${isDirty ? '' : 'display:none'}"></div>
                <div class="status-overlap" style="${isOverlap ? '' : 'display:none'}"></div>
            </div>
            <div class="tabs-list-close" ${!canClose ? 'style="display:none"' : ''}>&times;</div>
        `;

        item.onclick = () => {
            switchTab(index);
            document.getElementById('tabsDropdown').classList.remove('active');
        };
        
        item.querySelector('.tabs-list-close').onclick = async (e) => {
            e.stopPropagation();
            await closeTab(index);
            renderTabList();
        };

        container.appendChild(item);
    });
}
