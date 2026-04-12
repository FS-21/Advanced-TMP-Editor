let lastClosedTab = null;
let currentContextTabIndex = -1;

import { state, Tab, generateId } from './state.js';
import { updateUIState } from './main.js';
import { renderCanvas, updateTilesList, renderPalette, updateCanvasSize, renderOverlay, showConfirm } from './ui.js';
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
    document.getElementById('ctxCloseTab').onclick = () => {
        closeTab(currentContextTabIndex);
        ctxMenu.classList.remove('active');
    };
    document.getElementById('ctxCloseOthers').onclick = () => {
        closeOtherTabs(currentContextTabIndex);
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
    
    // Wheel to NAVIGATE between tabs as requested
    tabsContainer.addEventListener('wheel', (e) => {
        e.preventDefault();
        if (e.deltaY > 0) {
            // Scroll down/right -> Next tab
            if (state.activeTabIndex < state.tabs.length - 1) {
                switchTab(state.activeTabIndex + 1);
            }
        } else if (e.deltaY < 0) {
            // Scroll up/left -> Previous tab
            if (state.activeTabIndex > 0) {
                switchTab(state.activeTabIndex - 1);
            }
        }
    }, { passive: false });

    // Component initialization
    window.renderTabs = renderTabs;
    window.updateCurrentTabName = updateCurrentTabName;
    renderTabs();
}

export function createNewTab(fileName = null) {
    return createNewTabAt(state.tabs.length, fileName);
}

function createNewTabAt(index, fileName = null) {
    const id = generateId();
    const name = fileName || "";
    const tab = new Tab(id, fileName, state);
    tab.idName = name;
    
    // Truly empty tab by default. Tiles/tmpData are only populated 
    // when a file is loaded or a New TMP project is created via dialog.
    
    state.tabs.splice(index, 0, tab);
    switchTab(index);
    return tab;
}

function duplicateTabAt(index) {
    const source = state.tabs[index];
    // Sync live state if it's the active tab
    if (index === state.activeTabIndex) state.saveToTab(source);

    // Deep clone using structuredClone (handles Sets, TypedArrays, etc.)
    const clone = structuredClone(source);
    clone.id = generateId();
    
    state.tabs.splice(index + 1, 0, clone);
    switchTab(index + 1);
}

function closeOtherTabs(keptIndex) {
    const kept = state.tabs[keptIndex];
    state.tabs = [kept];
    switchTab(0);
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
    if (state.activeTabIndex !== -1 && state.tabs[state.activeTabIndex]) {
        const currentTab = state.tabs[state.activeTabIndex];
        state.saveToTab(currentTab);
    }

    state.activeTabIndex = index;
    const newTab = state.tabs[index];
    state.loadFromTab(newTab);

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

export async function closeTab(index, e) {
    if (e) e.stopPropagation();
    
    const tab = state.tabs[index];
    if (tab.hasChanges) {
        const confirmed = await showConfirm(
            t('dlg_confirm_title') || "Confirm",
            t('msg_confirm_close_tab') || "Changes will be lost. Close anyway?"
        );
        if (!confirmed) return;
    }

    // Save for reopen logic
    if (index === state.activeTabIndex) state.saveToTab(tab);
    lastClosedTab = structuredClone(tab);

    if (state.tabs.length <= 1) {
        // Reset single remaining tab state
        state.tabs[0] = new Tab(generateId());
        state.newFileCounter = 1;
        state.tabs[0].idName = `New File 1`;
        state.tabs[0].isNewProject = true;
        state.tabs[0].hasChanges = false;
        switchTab(0);
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
        tab.isNewProject = isNewProject;
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
