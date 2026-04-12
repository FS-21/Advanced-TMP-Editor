export const TRANSPARENT_COLOR = 0; // Index 0 is transparent in TMP

export class Tab {
    constructor(id, fileName = null, initialState = null) {
        this.id = id;
        this.fileName = fileName;
        this.idName = fileName || ``;
        this.isNewProject = false;
        this.fileHandle = null; // Stores Native File System handle for direct save

        this.palette = initialState ? JSON.parse(JSON.stringify(initialState.palette)) : Array.from({ length: 256 }, () => ({r:0, g:0, b:0}));
        this.tmpData = null; 
        this.currentTileIdx = -1;
        this.tiles = [];
        
        // Grid Info
        this.cblocks_x = 1;
        this.cblocks_y = 1;
        this.cx = 60;
        this.cy = 30;
        this.worldBounds = null;

        this.primaryColorIdx = 0;
        this.paletteSelection = new Set([0]);
        this.lastPaletteIdx = 0;
        this.dragSourceType = null;
        this.dragSourceCount = 0;

        this.zoom = initialState ? initialState.zoom : 1;
        this.canvasW = 800;
        this.canvasH = 600;

        // View Options
        this.showGrid = false;
        this.showCenter = false;
        this.isoGrid = 'none';
        this.showBackground = true;

        // Tools & Settings
        this.toolSettings = {
            brushSize: 1,
            brushShape: 'square',
        };

        // History
        this.history = [];
        this.historyPtr = -1;

        // UI State
        this.paletteVersion = 0;
        this.currentX = undefined;
        this.currentY = undefined;
        this.showSidePanel = false;

        this.tileSelection = new Set();
        this.subSelection = new Set();
        this.currentTileKey = null;
        this.bondSelection = true;
        this.flatCells = false;
        this.showGameGrid = false;
        this.showTileTable = false;
        this.visualMode = 'normal'; // 'normal', 'zdata', 'placeholders'
        this.moveMode = false;
        this.gameType = initialState ? initialState.gameType : 'ra2';
        this.overlappingTiles = new Set();
        this.hasSystemImage = false;
        this.hasChanges = false;
        this.hasMismatches = false;
        this.savedHistoryPtr = -1; // Track which history point is the 'saved' one
        this._isRestoringHistory = false;
    }
}

export const state = {
    // Current active state (proxied or swapped)
    palette: Array.from({ length: 256 }, () => ({r:0, g:0, b:0})),
    tmpData: null,
    currentTileIdx: -1,
    tiles: [],
    cblocks_x: 1,
    cblocks_y: 1,
    cx: 60,
    cy: 30,
    worldBounds: null,
    primaryColorIdx: 0,
    paletteSelection: new Set([0]),
    lastPaletteIdx: 0,
    dragSourceType: null,
    dragSourceCount: 0,
    isCtrlPressed: false,
    zoom: 1,
    canvasW: 800,
    canvasH: 600,
    showGrid: false,
    showCenter: false,
    isoGrid: 'none',
    showBackground: true,
    toolSettings: {
        brushSize: 1,
        brushShape: 'square',
    },
    history: [],
    historyPtr: -1,
    paletteVersion: 0,
    currentX: undefined,
    currentY: undefined,
    showSidePanel: false,
    translations: {},
    tileSelection: new Set(),
    subSelection: new Set(),
    currentTileKey: null,
    bondSelection: true,
    flatCells: false,
    showGameGrid: false,
    showTileTable: false,
    visualMode: 'normal',
    moveMode: false,
    gameType: 'ra2',
    overlappingTiles: new Set(),
    internalClipboard: null, 
    hasSystemImage: false,
    hasChanges: false,
    hasMismatches: false,
    fileHandle: null, // Current active file handle
    savedHistoryPtr: -1, // Track which history point is the 'saved' one
    _isRestoringHistory: false,

    // NEW: Tab Management
    tabs: [],
    activeTabIndex: -1,
    newFileCounter: 0,

    saveToTab(tab) {
        if (!tab) return;
        const keys = Object.keys(new Tab('dummy'));
        keys.forEach(k => {
            if (['id', 'fileName', 'idName', 'internalClipboard', 'hasSystemImage'].includes(k)) return;
            tab[k] = this[k];
        });
    },

    loadFromTab(tab) {
        if (!tab) return;
        const dummy = new Tab('dummy');
        const keys = Object.keys(dummy);
        keys.forEach(k => {
            if (['id', 'fileName', 'idName', 'internalClipboard', 'hasSystemImage'].includes(k)) return;
            this[k] = tab[k];
        });
    }
};

export function generateId() {
    return Math.random().toString(36).substr(2, 9);
}

export let activeTool = 'select';
export function setActiveTool(t) { activeTool = t; }

export let isDrawing = false;
export function setIsDrawing(v) { isDrawing = v; }

export let lastPos = null;
export function setLastPos(v) { lastPos = v; }
