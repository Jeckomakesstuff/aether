const { app, BrowserWindow, ipcMain, shell, clipboard } = require('electron');
const { Client } = require('minecraft-launcher-core');
const { Auth } = require('msmc');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const launcher = new Client();
let mainWindow;
let activeToken = null;

// CONSTANTS
const MODRINTH_API = 'https://api.modrinth.com/v2';
const FABRIC_API = 'https://meta.fabricmc.net/v2';

// CACHE
let versionCache = null;
let lastCacheTime = 0;
const CACHE_TTL = 3600000; // 1 Hour

// ADDONS
const AETHER_ADDONS = {
    "zoom": { id: "w7ThoJHV", name: "Zoomify", fileKeyword: "Zoomify" },
    "fullbright": { id: "8BmcQJ2H", name: "Fullbright", fileKeyword: "Fullbright" },
    "physics": { id: "ct4Tv8oR", name: "Physics Mod", fileKeyword: "physics-mod" },
    "3dskin": { id: "zV5r3pPn", name: "3D Skin Layers", fileKeyword: "3dskinlayers" },
    "mousetweaks": { id: "aC3cM3Vq", name: "Mouse Tweaks", fileKeyword: "MouseTweaks" },
    "appleskin": { id: "EsAfCjCV", name: "AppleSkin", fileKeyword: "AppleSkin" },
    "iris": { id: "YL57xq9U", name: "Iris Shaders", fileKeyword: "iris" }
};

// STATE
let authData = { accounts: [], selected: null };
let instances = [];
let activeInstance = null;
let globalSettings = { memory: 4096, javaPath: "", optimized: true, lastInstanceId: null, themeColor: "#3b82f6" };

// --- INIT ---
function loadData() {
    const root = path.resolve("./minecraft");
    if (!fs.existsSync(root)) fs.mkdirSync(root, {recursive:true});
    const instDir = path.join(root, "instances");
    if (!fs.existsSync(instDir)) fs.mkdirSync(instDir, {recursive:true});

    try {
        if (fs.existsSync('settings.json')) globalSettings = { ...globalSettings, ...JSON.parse(fs.readFileSync('settings.json')) };
        if (fs.existsSync('instances.json')) instances = JSON.parse(fs.readFileSync('instances.json'));
        if (fs.existsSync('auth.json')) authData = JSON.parse(fs.readFileSync('auth.json'));
    } catch (e) { console.log("Load Error:", e); }

    // Auto-Recover Profiles
    const folders = fs.readdirSync(instDir).filter(f => fs.statSync(path.join(instDir, f)).isDirectory());
    let recovered = false;
    folders.forEach(folder => {
        if (!instances.find(i => i.id === folder)) {
            instances.push({ id: folder, name: folder, version: "1.21.4", modLoader: "fabric", velocityMode: false });
            recovered = true;
        }
    });

    if (instances.length === 0) createDefaultInstance();
    else {
        activeInstance = instances.find(i => i.id === globalSettings.lastInstanceId) || instances[0];
        if (recovered) saveInstances();
    }
}

function createDefaultInstance() {
    const def = { id: "default", name: "Default Profile", version: "1.21.4", modLoader: "fabric", velocityMode: false };
    instances.push(def); activeInstance = def; saveInstances();
}

function saveInstances() {
    fs.writeFileSync('instances.json', JSON.stringify(instances, null, 2));
    globalSettings.lastInstanceId = activeInstance ? activeInstance.id : null;
    fs.writeFileSync('settings.json', JSON.stringify(globalSettings, null, 2));
}

function saveAuth() { fs.writeFileSync('auth.json', JSON.stringify(authData, null, 2)); }
function getInstanceFolder() { return activeInstance.id === "default" ? path.resolve("./minecraft") : path.resolve(`./minecraft/instances/${activeInstance.id}`); }

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1200, height: 800, frame: false, backgroundColor: '#0a0a0a',
        webPreferences: { nodeIntegration: true, contextIsolation: false, webSecurity: false }
    });
    mainWindow.loadFile('index.html');
}

app.whenReady().then(() => { loadData(); createMainWindow(); });

// --- OPTIMIZED HANDLERS ---

// Cached Version Fetcher (THE SPEED FIX)
ipcMain.handle('get-versions', async () => {
    const now = Date.now();
    if (versionCache && (now - lastCacheTime < CACHE_TTL)) return versionCache;
    
    try {
        console.log("[NET] Fetching fresh versions list...");
        const res = await axios.get('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
        versionCache = res.data.versions;
        lastCacheTime = now;
        return versionCache;
    } catch (e) {
        console.log("[NET] Version fetch failed, using fallback/cache");
        return versionCache || [];
    }
});

// Fast Addon Status
ipcMain.handle('get-addon-status', () => {
    const modsPath = path.join(getInstanceFolder(), "mods");
    if (!fs.existsSync(modsPath)) return {};
    const files = fs.readdirSync(modsPath).map(f => f.toLowerCase());
    const status = {};
    for (const [key, data] of Object.entries(AETHER_ADDONS)) {
        status[key] = files.some(f => f.includes(data.fileKeyword.toLowerCase()));
    }
    return status;
});

ipcMain.handle('toggle-addon', async (event, { addonKey, enable }) => {
    const addon = AETHER_ADDONS[addonKey];
    if (!addon) return { success: false };
    const modsPath = path.join(getInstanceFolder(), "mods");
    if (!fs.existsSync(modsPath)) fs.mkdirSync(modsPath, { recursive: true });

    if (enable) {
        try {
            const vRes = await axios.get(`${MODRINTH_API}/project/${addon.id}/version?loaders=["${activeInstance.modLoader}"]&game_versions=["${activeInstance.version}"]`);
            if (vRes.data.length === 0) return { success: false, msg: "Incompatible" };
            await downloadFile(vRes.data[0].files[0].url, path.join(modsPath, vRes.data[0].files[0].filename));
            return { success: true };
        } catch (e) { return { success: false, msg: "Error" }; }
    } else {
        try {
            const files = fs.readdirSync(modsPath);
            const target = files.find(f => f.toLowerCase().includes(addon.fileKeyword.toLowerCase()));
            if (target) fs.unlinkSync(path.join(modsPath, target));
            return { success: true };
        } catch (e) { return { success: false }; }
    }
});

// --- CORE UTILS ---
async function downloadFile(url, dest) {
    const writer = fs.createWriteStream(dest);
    const response = await axios({ url, method: 'GET', responseType: 'stream' });
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
}

function findBestJava(customPath) {
    if (customPath && fs.existsSync(customPath)) return customPath;
    const commonPaths = [
        "C:\\Program Files\\Java", 
        "C:\\Program Files (x86)\\Java", 
        "C:\\Program Files\\Eclipse Adoptium"
    ];
    // Fast Search: Prioritize Java 21
    for(const r of commonPaths) {
        if(!fs.existsSync(r)) continue;
        try {
            const f = fs.readdirSync(r).find(n => n.includes("21"));
            if(f) return path.join(r, f, "bin", "javaw.exe");
        } catch(e){}
    }
    return "javaw";
}

// --- LAUNCHER LOGIC ---
ipcMain.on('launch-game', async () => {
    if (!activeToken) return sendLog("[ERR] Log in first!", true);
    
    const root = path.resolve("./minecraft");
    const instRoot = getInstanceFolder();
    const ver = activeInstance.version;
    
    sendLog(`[SYS] Launching ${activeInstance.name}...`);
    
    let versionOpts = { number: ver, type: "release" };
    
    // Check Local Custom
    if (fs.existsSync(path.join(root, 'versions', ver, `${ver}.json`))) {
        versionOpts.type = "custom";
    }

    if (activeInstance.modLoader === "fabric") {
        const fid = await prepareFrankensteinFabric(root, ver);
        if (fid) versionOpts = { number: fid, type: "custom" };
        else sendLog("[WARN] Fabric failed, using vanilla.");
    }

    const opts = {
        authorization: activeToken.mclc(),
        root: root,
        version: versionOpts,
        memory: { max: globalSettings.memory + "M", min: "1024M" },
        javaPath: findBestJava(globalSettings.javaPath),
        overrides: { gameDirectory: instRoot, detached: false }
    };

    try {
        const proc = await launcher.launch(opts);
        proc.stdout.on('data', d => sendLog(d.toString()));
        proc.stderr.on('data', d => sendLog(`[ERR] ${d.toString()}`));
        proc.on('close', c => mainWindow.webContents.send('game-closed', c));
    } catch(e) { sendLog(`[FATAL] ${e}`, true); }
});

async function prepareFrankensteinFabric(root, ver) {
    try {
        // Simplified Frankenstein Builder
        // 1. Get Base
        let vData;
        const localP = path.join(root, 'versions', ver, `${ver}.json`);
        if(fs.existsSync(localP)) vData = JSON.parse(fs.readFileSync(localP));
        else {
            const m = (await axios.get('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')).data.versions.find(v=>v.id===ver);
            vData = (await axios.get(m.url)).data;
        }

        // 2. Get Fabric
        const safeVer = ver.match(/^1\.\d+(\.\d+)?/)?.[0] || "1.21.4";
        let lVer, fData;
        try {
            const lr = await axios.get(`${FABRIC_API}/versions/loader/${ver}`);
            lVer = lr.data[0].loader.version;
            fData = (await axios.get(`${FABRIC_API}/versions/loader/${ver}/${lVer}/profile/json`)).data;
        } catch(e) {
            const lr = await axios.get(`${FABRIC_API}/versions/loader/${safeFabricVer}`);
            lVer = lr.data[0].loader.version;
            fData = (await axios.get(`${FABRIC_API}/versions/loader/${safeFabricVer}/${lVer}/profile/json`)).data;
        }

        // 3. Loader Jar
        const lPath = path.join(root, "libraries/net/fabricmc/fabric-loader", lVer, `fabric-loader-${lVer}.jar`);
        if(!fs.existsSync(lPath)) {
            fs.mkdirSync(path.dirname(lPath), {recursive:true});
            await downloadFile(`https://maven.fabricmc.net/net/fabricmc/fabric-loader/${lVer}/fabric-loader-${lVer}.jar`, lPath);
        }

        // 4. Merge
        fData.downloads = vData.downloads; fData.assets = vData.assets; fData.assetIndex = vData.assetIndex;
        const libs = new Map();
        fData.libraries.forEach(l => libs.set(l.name.split(':')[1], l)); // Key by artifact ID
        vData.libraries.forEach(l => { if(!libs.has(l.name.split(':')[1])) libs.set(l.name.split(':')[1], l); });
        fData.libraries = Array.from(libs.values());
        
        const fid = `fabric-${lVer}-${ver}-custom`;
        const dir = path.join(root, "versions", fid);
        if(!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive:true});
        fs.writeFileSync(path.join(dir, `${fid}.json`), JSON.stringify(fData));
        return fid;
    } catch(e) { return null; }
}

function sendLog(m, err=false) { console.log(m); if(mainWindow) { mainWindow.webContents.send('console-log', m); if(err) mainWindow.webContents.send('force-console'); } }

// Basic Handlers
ipcMain.handle('get-instances', () => ({ list: instances, activeId: activeInstance.id }));
ipcMain.handle('create-instance', (e, d) => {
    const id = d.name.toLowerCase().replace(/\s+/g, '-') + "-" + Date.now().toString().slice(-4);
    const n = { id, name: d.name, version: d.version, modLoader: d.modLoader, velocityMode: false };
    const f = path.join(path.resolve("./minecraft"), "instances", id);
    if(!fs.existsSync(f)) fs.mkdirSync(f, {recursive:true});
    instances.push(n); activeInstance = n; saveInstances(); return { success: true };
});
ipcMain.handle('select-instance', (e, id) => { const t = instances.find(i=>i.id===id); if(t) { activeInstance=t; saveInstances(); return {success:true}; } return {success:false}; });
ipcMain.handle('delete-instance', (e, id) => {
    if(instances.length<=1) return {success:false, msg:"Cannot delete last"};
    instances = instances.filter(i=>i.id!==id);
    if(activeInstance.id===id) activeInstance=instances[0];
    saveInstances(); return {success:true};
});
ipcMain.handle('get-settings', () => ({ ...globalSettings, version: activeInstance.version, modLoader: activeInstance.modLoader, velocityMode: activeInstance.velocityMode }));
ipcMain.handle('save-settings', (e, s) => {
    if(s.memory) globalSettings.memory = s.memory;
    if(s.themeColor) globalSettings.themeColor = s.themeColor;
    if(s.version) activeInstance.version = s.version;
    if(s.modLoader) activeInstance.modLoader = s.modLoader;
    if(s.velocityMode !== undefined) activeInstance.velocityMode = s.velocityMode;
    saveInstances();
});
ipcMain.handle('login', async () => { try { const am = new Auth("select_account"); const xm = await am.launch("electron"); const t = await xm.getMinecraft(); const p = t.mclc(); const ex = authData.accounts.find(a=>a.uuid===p.uuid); if(ex) ex.refresh_token = xm.msToken.refresh_token; else authData.accounts.push({name:p.name, uuid:p.uuid, refresh_token:xm.msToken.refresh_token}); authData.selected = p.uuid; activeToken = t; saveAuth(); return p.name; } catch(e) { return "Error"; } });
ipcMain.handle('check-login', async () => { if(!authData.selected) return null; const acc = authData.accounts.find(a=>a.uuid===authData.selected); if(!acc) return null; try { const am = new Auth("select_account"); const xm = await am.refresh(acc.refresh_token); activeToken = await xm.getMinecraft(); acc.refresh_token = xm.msToken.refresh_token; saveAuth(); return activeToken.mclc().name; } catch(e) { return null; } });
ipcMain.handle('get-accounts', () => authData);
ipcMain.handle('switch-account', async (event, uuid) => { const acc = authData.accounts.find(a => a.uuid === uuid); if (!acc) return { success: false }; authData.selected = uuid; saveAuth(); try { const am = new Auth("select_account"); const xm = await am.refresh(acc.refresh_token); activeToken = await xm.getMinecraft(); acc.refresh_token = xm.msToken.refresh_token; saveAuth(); return { success: true, name: acc.name }; } catch (e) { return { success: false }; } });
ipcMain.handle('remove-account', (event, uuid) => { authData.accounts = authData.accounts.filter(a => a.uuid !== uuid); if (authData.selected === uuid) { authData.selected = authData.accounts.length>0 ? authData.accounts[0].uuid : null; activeToken=null; } saveAuth(); return { success: true }; });
ipcMain.handle('search-modrinth', async (e, q) => { try { return (await axios.get(`${MODRINTH_API}/search?query=${q}&facets=[["versions:${activeInstance.version}"],["project_type:mod"]]`)).data.hits; } catch(e){return[];} });
ipcMain.handle('search-resourcepacks', async (event, query) => { try { return (await axios.get(`${MODRINTH_API}/search?query=${query}&facets=[["project_type:resourcepack"], ["versions:${activeInstance.version}"]]`)).data.hits; } catch (e) { return []; } });
ipcMain.handle('get-local-mods', () => { const p = path.join(getInstanceFolder(), "mods"); return fs.existsSync(p) ? fs.readdirSync(p).filter(f => f.endsWith('.jar')) : []; });
ipcMain.handle('install-mod', async (event, projectId) => { const f = path.join(getInstanceFolder(), "mods"); if(!fs.existsSync(f)) fs.mkdirSync(f, {recursive:true}); try { const v = await axios.get(`${MODRINTH_API}/project/${projectId}/version?loaders=["${activeInstance.modLoader}"]&game_versions=["${activeInstance.version}"]`); if(v.data.length===0) return {success:false, msg:"Incompatible"}; const file = v.data[0].files[0]; await downloadFile(file.url, path.join(f, file.filename)); return {success:true, file:file.filename}; } catch(e){return{success:false, msg:e.message};} });
ipcMain.handle('install-resourcepack', async (event, projectId) => { const f = path.join(getInstanceFolder(), "resourcepacks"); if(!fs.existsSync(f)) fs.mkdirSync(f, {recursive:true}); try { const v = await axios.get(`${MODRINTH_API}/project/${projectId}/version?game_versions=["${activeInstance.version}"]`); if(v.data.length===0) return {success:false, msg:"Incompatible"}; const file = v.data[0].files[0]; await downloadFile(file.url, path.join(f, file.filename)); return {success:true, file:file.filename}; } catch(e){return{success:false, msg:e.message};} });
ipcMain.handle('delete-mod', (e, f) => { try { fs.unlinkSync(path.join(getInstanceFolder(), "mods", f)); return true; } catch(err) { return false; } });
ipcMain.handle('open-folder', (e, sub) => { const p = path.resolve(getInstanceFolder(), sub); if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); shell.openPath(p); });
ipcMain.handle('get-screenshots', () => { const d = path.join(getInstanceFolder(), "screenshots"); if(!fs.existsSync(d)) return []; return fs.readdirSync(d).filter(f=>f.match(/\.(png|jpg)$/)).map(f=>({file:f, time:fs.statSync(path.join(d,f)).mtime.getTime()})).sort((a,b)=>b.time-a.time); });
ipcMain.handle('get-screenshot-image', (e, f) => { try { return `data:image/png;base64,${fs.readFileSync(path.join(getInstanceFolder(), "screenshots", f)).toString('base64')}`; } catch(e){return null;} });
ipcMain.handle('delete-screenshot', (e, f) => { try { fs.unlinkSync(path.join(getInstanceFolder(), "screenshots", f)); return true; } catch(e){return false;} });
ipcMain.handle('share-profile', async () => { const f=path.join(getInstanceFolder(),"mods"); if(!fs.existsSync(f))return{success:false,msg:"No mods"}; const fsList=fs.readdirSync(f).filter(n=>n.endsWith('.jar')); if(fsList.length===0)return{success:false,msg:"No mods"}; const c=Buffer.from(JSON.stringify({v:activeInstance.version,m:fsList})).toString('base64'); clipboard.writeText(c); return{success:true,msg:"Copied!"}; });
ipcMain.handle('import-profile', async (e, code) => { try { const p=JSON.parse(Buffer.from(code,'base64').toString('utf-8')); if(p.v!==activeInstance.version) return{success:false,msg:"Version mismatch"}; const f=path.join(getInstanceFolder(),"mods"); if(!fs.existsSync(f))fs.mkdirSync(f,{recursive:true}); let c=0; for(const n of p.m){ const q=n.split('-')[0].replace('.jar',''); try{const h=(await axios.get(`${MODRINTH_API}/search?query=${q}&limit=1`)).data.hits; if(h.length>0){const v=(await axios.get(`${MODRINTH_API}/project/${h[0].project_id}/version?loaders=["${activeInstance.modLoader}"]&game_versions=["${activeInstance.version}"]`)).data; if(v.length>0){await downloadFile(v[0].files[0].url, path.join(f,v[0].files[0].filename)); c++;}}}catch(err){}} return{success:true,msg:`Imported ${c}`}; } catch(err){return{success:false,msg:"Invalid code"};} });