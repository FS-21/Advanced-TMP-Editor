# Advanced TMP Editor (ATE)

<img width="1360" height="718" alt="image" src="https://github.com/user-attachments/assets/29ea2370-b4b7-4791-a9a8-0c88a1773ead" />

A specialized web-based tool for managing and editing Westwood Studios' `.TMP` terrain file format.

> **Experiment & Vision:** This project is an **"AI-Vibe Coding"** experiment using the **Antigravity IDE**, exploring the limits of non-stop, instruction-based development to create high-performance, legacy format editors. Developed by **FS-21** (*C&C Reloaded* modder and lead developer).

## 🚀 Key Features

### 🗺️ Advanced Tile & Meta-Data Management
- **Efficient Workflow:** Move, clone, and copy tiles or specific "Extra Data" (Images or Z-Data) seamlessly between different files or within the same template.
- **Tabbed Interface:** Features a browser-like tab system that allows you to have multiple TMP files open at once, facilitating fast cross-file editing and asset comparison.
- **Visualization Modes:** Toggle between three distinct view modes: **Normal** (Game Rendering), **Z-Data** (Depth Map), and **Placeholder** (Boundary/Collision visualization).

### 📐 Z-Data (Depth) & Procedural Tools
- **Instant Z-Data Generation:** Advanced algorithms for generating accurate Z-buffer depth maps (3-27 range) with just a few clicks.
- **Parametric Shapes:** Effortlessly generate depth profiles for Slopes, Valleys, Cones, and custom terrain templates.
- **Procedural Z-Data Gen:** Create complex depth ramps and peak patterns automatically.
- **Advanced Mirroring:** Includes "Peak/Crest" and "Valley/Basin" logic (Inverse Mirroring) for professional-level terrain modeling.
- **Multi-Cell Batch Editing:** Select multiple tiles and modify Shared Properties (Terrain Type, Ramp, Height, Flags) simultaneously.
- **Independent Layer Sizing:** Correctly handles Extra Data layers with native dimensions, preventing buffer corruption.

## ⚙️ Configuration & Vanilla Mode
By default, the editor includes specialized palettes and content for **C&C Reloaded** (a *Yuri's Revenge* mod by FS-21). If you prefer a **standard/vanilla** experience:
1. Open the generated `advanced_tmp_editor.html` or the `index.html` of the PWA folder in a text editor.
2. Search for `window.CnCReloadedMode = true;` near the top of the file.
3. Change it to `window.CnCReloadedMode = false;`.
4. Save and reload the editor. This will hide all Reloaded-specific palette categories and UI elements.

### 🎨 Palette & Visualization
- **Versatile Palette Management:** Import and manage multiple palette sets. Your custom palettes are stored in the browser's **Local Storage**, remaining available whenever you return to the editor.
- **Palette Mapping:** Seamless integration with game palettes for TS, RA2, and Yuri's Revenge.
- **Real-time Preview:** Accurate visualization of terrain transitions and depth metadata.

## 📦 Distribution & Offline Use
- **Self-Contained Build:** The `build.py` script generates a single, standalone file named **`advanced_tmp_editor.html`**. This file is **100% portable** and works entirely **offline**, making it ideal for distributed modding environments.
- **PWA Capabilities:** Built-in support for Progressive Web App features. By hosting the files, users can install the TMP editor as a standalone desktop application.

## 🛠️ Compatibility & Technology
- **Vanilla JS:** Built for high performance using modern standards.
- **Recommended Browsers:** **Chrome** or **Edge** are recommended for the most robust experience, especially for PWA features and native-like file handling.
- **Firefox Notice:** Some persistence features or PWA installation capabilities may behave differently or be restricted in Firefox compared to Chromium-based browsers.

## 🌐 Internationalization (i18n)
The TMP editor supports multiple languages:
- **English** (EN)
- **Spanish** (ES)
- **Russian** (RU)
- **German** (DE)
- **French** (FR)
- **Chinese** (Simplified & Traditional)

## 🔨 How to Build
Run `python build.py` from the root directory to update the standalone file.

---
*Created for the C&C Modding community.*

## 📜 Legal Disclaimer
**Command & Conquer** (including *Tiberian Sun*, *Red Alert 2*, and *Yuri's Revenge*) is a trademark or registered trademark of Electronic Arts Inc. in the U.S. and/or other countries. This project is an unofficial, community-driven toolset and is not affiliated with, endorsed by, or sponsored by Electronic Arts. It is developed for educational and modding preservation purposes.
