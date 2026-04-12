import { t } from './translations.js';
export const elements = {
    // Canvases
    get bgCanvas() { return document.getElementById('bgCanvas'); },
    get mainCanvas() { return document.getElementById('mainCanvas'); },
    get overlayCanvas() { return document.getElementById('overlayCanvas'); },
    get canvasWrapper() { return document.getElementById('canvasWrapper'); },
    get canvasScrollArea() { return document.getElementById('canvasScrollArea'); },
    get canvasArea() { return document.getElementById('canvasArea'); },

    // Contexts
    get bgCtx() { return this.bgCanvas ? this.bgCanvas.getContext('2d') : null; },
    get ctx() { return this.mainCanvas ? this.mainCanvas.getContext('2d') : null; },
    get overlayCtx() { return this.overlayCanvas ? this.overlayCanvas.getContext('2d') : null; },

    // Panels
    get paletteGrid() { return document.getElementById('paletteGrid'); },
    get panelLeft() { return document.getElementById('panelLeft'); },
    get panelLeftResizer() { return document.getElementById('panelLeftResizer'); },
    get panelRightResizer() { return document.getElementById('panelRightResizer'); },
    get historyList() { return document.getElementById('historyList'); },


    
    // Right Panel (Tiles)
    get tilesList() { return document.getElementById('tilesList'); },
    get tilesContainer() { return document.getElementById('tilesContainer'); },
    get btnAddTile() { return document.getElementById('btnAddTile'); },
    get btnNewExtra() { return document.getElementById('btnNewExtra'); },
    get btnDuplicateTile() { return document.getElementById('btnDuplicateTile'); },
    get btnDeleteTile() { return document.getElementById('btnDeleteTile'); },
    get btnMoveTilesUp() { return document.getElementById('btnMoveTilesUp'); },
    get btnMoveTilesDown() { return document.getElementById('btnMoveTilesDown'); },
    get chkBondSelection() { return document.getElementById('chkBondSelection'); },
    get chkFlatCells() { return document.getElementById('chkFlatCells'); },


    // Top Bar / Toolbar
    get btnNew() { return document.getElementById('btnNew'); },
    get btnOpenTmp() { return document.getElementById('menuOpen'); },
    get fileInTmp() { return document.getElementById('fileInTmp'); },
    get fileInZData() { return document.getElementById('fileInZData'); },
    get fileInSurfaceData() { return document.getElementById('fileInSurfaceData'); },
    get fileInExtraData() { return document.getElementById('fileInExtraData'); },
    get btnSaveTmp() { return document.getElementById('menuSave'); },

    get chkShowBackground() { return document.getElementById('chkShowBackground'); },
    get btnUndo() { return document.getElementById('btnUndo'); },
    get btnRedo() { return document.getElementById('btnRedo'); },
    get btnMoveMode() { return document.getElementById('btnMoveMode'); },

    // Left Panel
    get primaryColorPreview() { return document.getElementById('primaryColorPreview'); },

    // Right Panel (duplicate removal)
    get panelRight() { return document.getElementById('panelRight'); },

    // Properties
    get 'prop-colorShift'() { return document.getElementById('prop-colorShift'); },

    get chkShowTileTable() { return document.getElementById('chkShowTileTable'); },
    get tileDataTablePanel() { return document.getElementById('tileDataTablePanel'); },
    get tileDataTableBody() { return document.getElementById('tileDataTableBody'); },
    get tileDataTableCount() { return document.getElementById('tileDataTableCount'); },
    get tileDataTableResizer() { return document.getElementById('tileDataTableResizer'); },
    get btnToggleTileTable() { return document.getElementById('btnToggleTileTable'); },
    get menuToggleTileTable() { return document.getElementById('menuToggleTileTable'); },
    get chkMenuTileTable() { return document.getElementById('chkMenuTileTable'); },

    // Modals


    get closeModal() { return document.querySelector('.close-modal'); },

    // Import/Open TMP Dialog
    get importTmpDialog() { return document.getElementById('importTmpDialog'); },
    get impTmpPalGrid() { return document.getElementById('impTmpPalGrid'); },
    get btnImpTmpLoadFile() { return document.getElementById('btnImpTmpLoadFile'); },
    get impTmpCanvas() { return document.getElementById('impTmpCanvas'); },
    get impTmpInfo() { return document.getElementById('impTmpInfo'); },
    get btnImpTmpPlay() { return document.getElementById('btnImpTmpPlay'); },
    get btnImpTmpStep() { return document.getElementById('btnImpTmpStep'); },
    get impTmpSlider() { return document.getElementById('impTmpSlider'); },
    get impTmpCounter() { return document.getElementById('impTmpCounter'); },
    get btnCancelImpTmp() { return document.getElementById('btnCancelImpTmp'); },
    get btnConfirmImpTmp() { return document.getElementById('btnConfirmImpTmp'); },
    get chkImpTmpNoShadow() { return document.getElementById('chkImpTmpNoShadow'); },
    get inpImpTmpFile() { return document.getElementById('inpImpTmpFile'); },

    // Status Bar
    get statusBar() { return document.getElementById('statusBar'); },
    get resDisplay() { return document.getElementById('resDisplay'); },
    get statusSelectionInfo() { return document.getElementById('statusSelectionInfo'); },
    get selectionDisplay() { return document.getElementById('selectionDisplay'); },
    get coordsDisplay() { return document.getElementById('coordsDisplay'); },
    get btnZoomMinus() { return document.getElementById('btnZoomMinus'); },
    get btnZoomPlus() { return document.getElementById('btnZoomPlus'); },
    get btnZoomReset() { return document.getElementById('btnZoomReset'); },
    get inpZoom() { return document.getElementById('inpZoom'); },
    get zoomSizeBar() { return document.getElementById('zoomSizeBar'); },
    get zoomVal() { return document.getElementById('zoomVal'); },

    // Grid
    get btnToggleGrid() { return document.getElementById('btnToggleGrid'); },
    get menuGridShowNone() { return document.getElementById('menuGridShowNone'); },
    get menuGridShowLight() { return document.getElementById('menuGridShowLight'); },
    get menuGridShowDark() { return document.getElementById('menuGridShowDark'); },
    get menuModeNormal() { return document.getElementById('menuModeNormal'); },
    get menuModeZData() { return document.getElementById('menuModeZData'); },
    get menuModePlaceholders() { return document.getElementById('menuModePlaceholders'); },
    get chkMenuModeNormal() { return document.getElementById('chkMenuModeNormal'); },
    get chkMenuModeZData() { return document.getElementById('chkMenuModeZData'); },
    get chkMenuModePlaceholders() { return document.getElementById('chkMenuModePlaceholders'); },
    get pixelGridOverlay() { return document.getElementById('pixelGridOverlay'); },

    // Confirm Dialog
    get confirmDialog() { return document.getElementById('confirmDialog'); },
    get confirmTitle() { return document.getElementById('confirmTitle'); },
    get confirmMessage() { return document.getElementById('confirmMessage'); },
    get btnConfirmYes() { return document.getElementById('btnConfirmYes'); },
    get btnConfirmNo() { return document.getElementById('btnConfirmNo'); },

    get btnNewTmpCancel() { return document.getElementById('btnNewTmpCancel'); },
    get btnNewTmpCreate() { return document.getElementById('btnNewTmpCreate'); },
    get limitNotification() { return document.getElementById('limitNotification'); },
    get limitNotificationMsg() { return document.getElementById('limitNotificationMsg'); },

    // Export/Save As TMP Dialog
    get exportTmpDialog() { return document.getElementById('exportTmpDialog'); },
    get btnCancelExpTmp() { return document.getElementById('btnCancelExpTmp'); },
    get btnConfirmExpTmp() { return document.getElementById('btnConfirmExpTmp'); },
    get txtExpTmpName() { return document.getElementById('txtExpTmpName'); },
    get selExpTmpType() { return document.getElementById('selExpTmpType'); },
    get dropZoneOverlay() { return document.getElementById('dropZoneOverlay'); }
};

export const LAND_TYPE_NAMES = {
    0: "land_clear",
    1: "land_clear",
    2: "land_ice",
    3: "land_ice",
    4: "land_ice",
    5: "land_tunnel",
    6: "land_railroad",
    7: "land_rock",
    8: "land_rock",
    9: "land_water",
    10: "land_beach",
    11: "land_road",
    12: "land_road",
    13: "land_clear",
    14: "land_rough",
    15: "land_cliff"
};

export const RAMP_TYPE_NAMES = {
    0: "ramp_none",
    1: "ramp_west",
    2: "ramp_north",
    3: "ramp_east",
    4: "ramp_south",
    5: "ramp_nw",
    6: "ramp_ne",
    7: "ramp_se",
    8: "ramp_sw",
    9: "ramp_inw",
    10: "ramp_ine",
    11: "ramp_ise",
    12: "ramp_isw",
    13: "ramp_steep_se",
    14: "ramp_steep_sw",
    15: "ramp_steep_nw",
    16: "ramp_steep_ne",
    17: "ramp_double_up_swne",
    18: "ramp_double_down_swne",
    19: "ramp_double_up_nwse",
    20: "ramp_double_down_nwse"
};

export function getLandTypeName(type) {
    const key = LAND_TYPE_NAMES[type];
    return key ? t(key) : "";
}

export function getRampTypeName(type) {
    const key = RAMP_TYPE_NAMES[type];
    return key ? t(key) : "";
}

window.elements = elements;
