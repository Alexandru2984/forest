import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

// --- DOM REFS ---
const statusEl       = document.getElementById('status');
const loadingScreen  = document.getElementById('loading-screen');
const ghInput        = document.getElementById('github-input');
const ghToken        = document.getElementById('github-token');
const ghSubmit       = document.getElementById('github-submit');
const filterBtn      = document.getElementById('filter-btn');
const filterLang     = document.getElementById('filter-lang');
const filterCreated  = document.getElementById('filter-created');
const filterUpdated  = document.getElementById('filter-updated');
const tooltip        = document.getElementById('tooltip');
const controlsToggle = document.getElementById('controls-toggle');
const controlsBody   = document.getElementById('controls-body');
const statRepos      = document.getElementById('stat-repos');
const statCommits    = document.getElementById('stat-commits');
const statLangs      = document.getElementById('stat-langs');
const statFps        = document.getElementById('stat-fps');

const panelToggle    = document.getElementById('panel-toggle');
const joystick       = document.getElementById('joystick');
const joystickKnob   = joystick.querySelector('.joystick-knob');
const statApi        = document.getElementById('stat-api');
const repoSearch     = document.getElementById('repo-search');
const btnRandom      = document.getElementById('btn-random');
const btnShare       = document.getElementById('btn-share');
const btnExport      = document.getElementById('btn-export');
const btnLegend      = document.getElementById('btn-legend');
const btnOrbit       = document.getElementById('btn-orbit');
const btnHelp        = document.getElementById('btn-help');
const rememberToken  = document.getElementById('remember-token');
const legendEl       = document.getElementById('legend');
const legendList     = document.getElementById('legend-list');
const helpModal      = document.getElementById('help-modal');
const helpClose      = document.getElementById('help-close');

let currentTargetUser = ghInput.value.trim() || 'Alexandru2984';
let allFetchedRepos = []; // global state for filtering
let lastRenderedRepos = []; // repos currently drawn (post-filter)
let repoPositions = {};   // full_name -> THREE.Vector3 (for search focus)
let highlightedRepo = null;
let highlightUntil = 0;
let pendingFilters = {};  // deep-link filters applied after first fetch

// --- ENVIRONMENT CAPABILITIES ---
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const isTouch = window.matchMedia('(pointer: coarse)').matches;
if (isTouch) document.body.classList.add('touch-device');

// --- HELPERS ---
function setStatus(text, type) {
    statusEl.textContent = text;
    statusEl.className = type ? 'status-' + type : '';
}

function escapeHTML(str) {
    if (!str) return '';
    return str.toString()
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function updateStats(repos) {
    const langs = new Set();
    let commits = 0;
    repos.forEach(r => { langs.add(r.language || 'Unknown'); commits += r.commits ? r.commits.length : 0; });
    statRepos.textContent = repos.length;
    statCommits.textContent = commits;
    statLangs.textContent = langs.size;
}

// Brief bloom "flash" for transitions — suppressed under reduced-motion.
function flashBloom(strength, ms) {
    if (reducedMotion) return;
    bloomPass.strength = strength;
    setTimeout(() => { bloomPass.strength = 1.8; }, ms);
}

// --- SCENE SETUP ---
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x050505, 0.003);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 4000);
camera.position.set(0, 150, 250);

const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, preserveDrawingBuffer: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ReinhardToneMapping;
document.body.appendChild(renderer.domElement);

// --- POST PROCESSING (BLOOM) ---
const renderScene = new RenderPass(scene, camera);
const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 1.5, 0.4, 0.85);
bloomPass.threshold = 0.1;
bloomPass.strength = 1.8;
bloomPass.radius = 0.5;

const composer = new EffectComposer(renderer);
composer.addPass(renderScene);
composer.addPass(bloomPass);

// --- CONTROLS ---
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.maxPolarAngle = Math.PI / 2 + 0.1;
controls.minDistance = 2;
controls.maxDistance = 2000;
controls.target.set(0, 10, 0);

const keys = { w: false, a: false, s: false, d: false, q: false, e: false };
window.addEventListener('keydown', (e) => {
    const tag = document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    const k = e.key.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(keys, k)) keys[k] = true;
});
window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(keys, k)) keys[k] = false;
});

// --- LIGHTS & ENV ---
const ambientLight = new THREE.AmbientLight(0x334433);
scene.add(ambientLight);

const gridHelper = new THREE.GridHelper(1600, 800, 0x00ff80, 0x0a1a10);
gridHelper.material.opacity = 0.15;
gridHelper.material.transparent = true;
scene.add(gridHelper);

// --- GPU INSTANCING GLOBALS ---
const languageColors = {
    'JavaScript': 0xf1e05a, 'TypeScript': 0x3178c6, 'Python': 0x3572A5,
    'Go': 0x00ADD8, 'Rust': 0xdea584, 'C++': 0xf34b7d, 'C#': 0x178600,
    'Java': 0xb07219, 'HTML': 0xe34c26, 'CSS': 0x563d7c, 'Shell': 0x89e051,
    'Elixir': 0x6e4a7e, 'Swift': 0xF05138, 'Ruby': 0x701516, 'PHP': 0x4F5D95,
    'C': 0x555555, 'Lua': 0x000080, 'Vue': 0x41b883, 'Jupyter Notebook': 0xDA5B0B
};

const geometries = [
    new THREE.IcosahedronGeometry(0.6, 0),
    new THREE.OctahedronGeometry(0.6, 0),
    new THREE.DodecahedronGeometry(0.6, 0)
];

let instancedMeshes = [];
let nodeDataMap = {};
let branchLinesMesh = null;
let trunkMesh = null;

const forestGroup = new THREE.Group();
scene.add(forestGroup);

function clearForest() {
    instancedMeshes.forEach(mesh => {
        mesh.geometry.dispose();
        mesh.material.dispose();
        forestGroup.remove(mesh);
    });
    instancedMeshes = [];

    if (branchLinesMesh) {
        branchLinesMesh.geometry.dispose();
        branchLinesMesh.material.dispose();
        forestGroup.remove(branchLinesMesh);
        branchLinesMesh = null;
    }
    if (trunkMesh) {
        trunkMesh.geometry.dispose();
        trunkMesh.material.dispose();
        forestGroup.remove(trunkMesh);
        trunkMesh = null;
    }

    nodeDataMap = {};
    repoPositions = {};
}

function populateLanguageDropdown(repos) {
    const langSet = new Set();
    repos.forEach(r => langSet.add(r.language || 'Unknown'));

    const prevVal = filterLang.value;
    filterLang.innerHTML = '<option value="">ALL</option>';

    Array.from(langSet).sort().forEach(l => {
        const opt = document.createElement('option');
        opt.value = l;
        opt.textContent = l.toUpperCase();
        if (l === prevVal) opt.selected = true;
        filterLang.appendChild(opt);
    });
}

function buildForest(repos) {
    clearForest();

    const reposByLang = {};
    let totalCommits = 0;
    repos.forEach(r => {
        const lang = r.language || 'Unknown';
        if (!reposByLang[lang]) reposByLang[lang] = [];
        reposByLang[lang].push(r);
        totalCommits += r.commits ? r.commits.length : 0;
    });

    const langs = Object.keys(reposByLang);
    if (langs.length === 0) return;

    langs.sort((a, b) => reposByLang[b].length - reposByLang[a].length);

    for (let i = 0; i < 3; i++) {
        const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
        const im = new THREE.InstancedMesh(geometries[i], mat, Math.max(totalCommits, 1));
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        im.count = 0;
        instancedMeshes.push(im);
        forestGroup.add(im);
    }

    const linePositions = new Float32Array(totalCommits * 6);
    const lineColors = new Float32Array(totalCommits * 6);
    let lineIndex = 0;

    const trunkGeo = new THREE.CylinderGeometry(0.4, 1.2, 1, 6);
    const trunkMat = new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.5 });
    trunkMesh = new THREE.InstancedMesh(trunkGeo, trunkMat, Math.max(repos.length, 1));
    forestGroup.add(trunkMesh);

    const matrix = new THREE.Matrix4();
    const colorObj = new THREE.Color();
    let trunkCount = 0;

    const totalRepos = repos.length;
    let currentAngle = 0;

    langs.forEach((lang) => {
        const langRepos = reposByLang[lang];
        const baseColorHex = languageColors[lang] || 0x888888;
        const baseColor = new THREE.Color(baseColorHex);
        const hsl = {};
        baseColor.getHSL(hsl);

        const angleSlice = (langRepos.length / totalRepos) * (Math.PI * 2);
        const sectorMidAngle = currentAngle + (angleSlice / 2);

        langRepos.forEach((repo, repoIndex) => {
            if (!repo.commits || repo.commits.length === 0) return;

            const r = 30 + (Math.floor(repoIndex / 5) * 20) + Math.random() * 15;
            const theta = sectorMidAngle + (Math.random() - 0.5) * (angleSlice * 0.85);

            const x = Math.cos(theta) * r;
            const z = Math.sin(theta) * r;

            const hShift = (Math.random() - 0.5) * 0.15;
            let newH = hsl.h + hShift;
            if (newH < 0) newH += 1;
            if (newH > 1) newH -= 1;
            const newS = Math.max(0.5, Math.min(1.0, hsl.s + (Math.random() - 0.5) * 0.3));
            const newL = Math.max(0.4, Math.min(0.8, hsl.l + (Math.random() - 0.5) * 0.4));

            colorObj.setHSL(newH, newS, newL);
            const treeColorHex = colorObj.getHex();

            const cCount = repo.commits.length;
            const height = 4 + (cCount * 0.8);

            matrix.identity();
            matrix.makeScale(1, height, 1);
            matrix.setPosition(x, height / 2, z);
            trunkMesh.setMatrixAt(trunkCount, matrix);
            trunkMesh.setColorAt(trunkCount, colorObj);
            trunkCount++;

            repoPositions[repo.full_name] = new THREE.Vector3(x, height / 2, z);

            const geomType = Math.floor(treeColorHex % 3);
            const activeIM = instancedMeshes[geomType];

            for (let j = 0; j < cCount; j++) {
                const commit = repo.commits[j];
                const yPos = 2 + (j * (height - 2) / cCount) + (Math.random() * 2.0);
                const rad = 2 + Math.random() * 5 + (yPos * 0.1);
                const angle = Math.random() * Math.PI * 2;

                const nx = x + Math.cos(angle) * rad;
                const ny = yPos;
                const nz = z + Math.sin(angle) * rad;

                const branchStartX = x;
                const branchStartY = yPos - 1.5;
                const branchStartZ = z;

                const id = activeIM.count;
                matrix.identity();
                matrix.setPosition(nx, ny, nz);
                activeIM.setMatrixAt(id, matrix);
                activeIM.setColorAt(id, colorObj);

                const cDate = new Date(repo.created_at).toLocaleDateString();
                const uDate = new Date(repo.updated_at).toLocaleDateString();

                nodeDataMap[`${geomType}_${id}`] = {
                    rx: (Math.random() - 0.5) * 0.05,
                    ry: (Math.random() - 0.5) * 0.05,
                    baseY: ny,
                    offset: Math.random() * 100,
                    origMatrix: matrix.clone(),

                    repo: repo.full_name,
                    language: lang,
                    created: cDate,
                    updated: uDate,
                    lineColorHex: treeColorHex,
                    commitHash: commit.hash,
                    message: commit.message,
                    url: commit.url
                };

                activeIM.count++;

                linePositions[lineIndex] = branchStartX;
                linePositions[lineIndex + 1] = branchStartY;
                linePositions[lineIndex + 2] = branchStartZ;
                lineColors[lineIndex] = colorObj.r;
                lineColors[lineIndex + 1] = colorObj.g;
                lineColors[lineIndex + 2] = colorObj.b;

                linePositions[lineIndex + 3] = nx;
                linePositions[lineIndex + 4] = ny;
                linePositions[lineIndex + 5] = nz;
                lineColors[lineIndex + 3] = colorObj.r;
                lineColors[lineIndex + 4] = colorObj.g;
                lineColors[lineIndex + 5] = colorObj.b;

                lineIndex += 6;
            }
        });

        currentAngle += angleSlice;
    });

    instancedMeshes.forEach(im => {
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
    });
    trunkMesh.instanceMatrix.needsUpdate = true;
    if (trunkMesh.instanceColor) trunkMesh.instanceColor.needsUpdate = true;

    if (lineIndex > 0) {
        const lineGeo = new THREE.BufferGeometry();
        lineGeo.setAttribute('position', new THREE.BufferAttribute(linePositions.slice(0, lineIndex), 3));
        lineGeo.setAttribute('color', new THREE.BufferAttribute(lineColors.slice(0, lineIndex), 3));

        const lineMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.3 });
        branchLinesMesh = new THREE.LineSegments(lineGeo, lineMat);
        forestGroup.add(branchLinesMesh);
    }

    lastRenderedRepos = repos;
    if (!legendEl.hidden) buildLegend(repos);
}

// --- FILTERING LOGIC ---
function applyFilters() {
    const langVal = filterLang.value;
    const createdVal = filterCreated.value;
    const updatedVal = filterUpdated.value;

    const filtered = allFetchedRepos.filter(r => {
        if (langVal && (r.language || 'Unknown') !== langVal) return false;
        if (createdVal && new Date(r.created_at) < new Date(createdVal)) return false;
        if (updatedVal && new Date(r.updated_at) < new Date(updatedVal)) return false;
        return true;
    });

    flashBloom(3.5, 400);

    buildForest(filtered);
    updateStats(filtered);
    setStatus(`SHOWING ${filtered.length} / ${allFetchedRepos.length} REPOS`, 'success');
}

filterBtn.addEventListener('click', applyFilters);

// --- GITHUB API FETCHING (via GO PROXY) ---
async function fetchGitHubData(username, token) {
    setStatus('FETCHING FROM GO PROXY (CONCURRENT)…', 'loading');
    ghSubmit.classList.add('is-loading');
    ghSubmit.classList.remove('pulse-idle');

    try {
        const headers = {};
        if (token && token.trim() !== '') {
            headers['Authorization'] = `Bearer ${token.trim()}`;
        }
        const res = await fetch(`/api/github?user=${encodeURIComponent(username)}`, { headers });

        const rl = res.headers.get('X-GitHub-RateLimit-Remaining');
        if (rl !== null && rl !== '') statApi.textContent = rl;

        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Proxy Error ${res.status}: ${text}`);
        }

        allFetchedRepos = await res.json();

        if (!allFetchedRepos || allFetchedRepos.length === 0) {
            setStatus(`NO REPOS FOUND FOR [${username}]`, 'error');
            updateStats([]);
            return;
        }

        populateLanguageDropdown(allFetchedRepos);
        updateStats(allFetchedRepos);

        filterLang.value = '';
        filterCreated.value = '';
        filterUpdated.value = '';

        buildForest(allFetchedRepos);
        setStatus(`[LIVE] SYNCED ${allFetchedRepos.length} REPOS FOR: ${username.toUpperCase()}`, 'success');

        persistSession(username, token);

        // Apply any deep-link filters carried in the URL on first load.
        if (pendingFilters.lang || pendingFilters.created || pendingFilters.updated) {
            if (pendingFilters.lang) filterLang.value = pendingFilters.lang;
            if (pendingFilters.created) filterCreated.value = pendingFilters.created;
            if (pendingFilters.updated) filterUpdated.value = pendingFilters.updated;
            pendingFilters = {};
            applyFilters();
        }

    } catch (err) {
        setStatus(`ERROR: ${err.message}`, 'error');
    } finally {
        ghSubmit.classList.remove('is-loading');
    }
}

setStatus('AWAITING SCAN… ENTER USERNAME / TOKEN AND CLICK FETCH', '');

// --- PARTICLES ---
const particleCount = 6000;
const particlesGeo = new THREE.BufferGeometry();
const particlePos = new Float32Array(particleCount * 3);
const particleVel = new Float32Array(particleCount);

for (let i = 0; i < particleCount; i++) {
    particlePos[i * 3] = (Math.random() - 0.5) * 800;
    particlePos[i * 3 + 1] = Math.random() * 400;
    particlePos[i * 3 + 2] = (Math.random() - 0.5) * 800;
    particleVel[i] = -0.1 - Math.random() * 0.3;
}
particlesGeo.setAttribute('position', new THREE.BufferAttribute(particlePos, 3));
const particleMat = new THREE.PointsMaterial({ color: 0x88ffcc, size: 0.3, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending });
const particleSystem = new THREE.Points(particlesGeo, particleMat);
scene.add(particleSystem);

// --- RAYCASTING (Throttled for Performance) ---
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let hoveredNodeInfo = null;
let lastMouseTime = 0;

window.addEventListener('mousemove', (event) => {
    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
    tooltip.style.left = (event.clientX + 20) + 'px';
    tooltip.style.top = (event.clientY + 20) + 'px';
    lastMouseTime = Date.now();
}, false);

window.addEventListener('click', (event) => {
    if (event.target.closest('.top-bar') || event.target.closest('#tooltip') ||
        event.target.closest('#controls-help') || event.target.closest('#stats-bar')) return;
    if (hoveredNodeInfo && hoveredNodeInfo.url) {
        // SECURITY: only ever open canonical GitHub commit URLs.
        if (hoveredNodeInfo.url.startsWith('https://github.com/')) {
            window.open(hoveredNodeInfo.url, '_blank', 'noopener,noreferrer');
        } else {
            console.warn('Blocked opening invalid URL:', hoveredNodeInfo.url);
        }
    }
}, false);

// --- UI LOGIC ---
function triggerScan() {
    const val = ghInput.value.trim();
    const tokenVal = ghToken.value.trim();
    if (val.length > 0) {
        currentTargetUser = val;
        flashBloom(4.0, 600);
        fetchGitHubData(currentTargetUser, tokenVal);
    }
}
ghSubmit.addEventListener('click', triggerScan);
ghInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') triggerScan(); });
ghToken.addEventListener('keydown', (e) => { if (e.key === 'Enter') triggerScan(); });

// Collapsible controls help
function toggleControls() {
    const open = controlsBody.classList.toggle('expanded');
    controlsToggle.querySelector('.chevron').classList.toggle('open', open);
    controlsToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
}
controlsToggle.addEventListener('click', toggleControls);
controlsToggle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleControls(); }
});

// Mobile: hide/show the control panels to reveal the forest
panelToggle.addEventListener('click', () => {
    const hidden = document.body.classList.toggle('panels-hidden');
    panelToggle.textContent = hidden ? '✕' : '☰';
    panelToggle.setAttribute('aria-pressed', hidden ? 'true' : 'false');
});

// Mobile: analog joystick driving the same fly-camera movement as WASD
const JOY_RADIUS = 45;
const joyVec = { x: 0, y: 0 };
let joyActive = false;

function joyUpdate(e) {
    if (!joyActive) return;
    const rect = joystick.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = e.clientX - cx;
    let dy = e.clientY - cy;
    const dist = Math.hypot(dx, dy);
    if (dist > JOY_RADIUS) { dx = dx / dist * JOY_RADIUS; dy = dy / dist * JOY_RADIUS; }
    joystickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
    joyVec.x = dx / JOY_RADIUS;
    joyVec.y = dy / JOY_RADIUS;
}
function joyEnd() {
    joyActive = false;
    joyVec.x = 0; joyVec.y = 0;
    joystickKnob.style.transform = 'translate(0, 0)';
}
joystick.addEventListener('pointerdown', (e) => {
    joyActive = true;
    joystick.setPointerCapture(e.pointerId);
    joyUpdate(e);
});
joystick.addEventListener('pointermove', joyUpdate);
joystick.addEventListener('pointerup', joyEnd);
joystick.addEventListener('pointercancel', joyEnd);

// ==========================================================================
// FEATURES
// ==========================================================================

// --- Language legend ---
function buildLegend(repos) {
    const counts = {};
    repos.forEach(r => { const l = r.language || 'Unknown'; counts[l] = (counts[l] || 0) + 1; });
    const langs = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);

    legendList.innerHTML = '';
    langs.forEach(l => {
        const hex = '#' + (languageColors[l] || 0x888888).toString(16).padStart(6, '0');
        const row = document.createElement('div');
        row.className = 'legend-row';

        const sw = document.createElement('span');
        sw.className = 'legend-swatch';
        sw.style.background = hex;
        sw.style.color = hex;

        const name = document.createElement('span');
        name.textContent = l; // textContent => safe from XSS

        const cnt = document.createElement('span');
        cnt.className = 'legend-count';
        cnt.textContent = counts[l];

        row.append(sw, name, cnt);
        legendList.appendChild(row);
    });
}

btnLegend.addEventListener('click', () => {
    const show = legendEl.hidden;
    legendEl.hidden = !show;
    btnLegend.classList.toggle('active', show);
    btnLegend.setAttribute('aria-pressed', show ? 'true' : 'false');
    if (show) buildLegend(lastRenderedRepos);
});

// --- Auto-orbit ---
btnOrbit.addEventListener('click', () => {
    controls.autoRotate = !controls.autoRotate;
    controls.autoRotateSpeed = 0.6;
    btnOrbit.classList.toggle('active', controls.autoRotate);
    btnOrbit.setAttribute('aria-pressed', controls.autoRotate ? 'true' : 'false');
});

// --- Export PNG ---
btnExport.addEventListener('click', () => {
    composer.render(); // ensure a fresh frame is in the (preserved) buffer
    try {
        const url = renderer.domElement.toDataURL('image/png');
        const a = document.createElement('a');
        a.href = url;
        a.download = `code-forest-${currentTargetUser || 'export'}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setStatus('SAVED FOREST SNAPSHOT (PNG)', 'success');
    } catch (e) {
        setStatus(`EXPORT FAILED: ${e.message}`, 'error');
    }
});

// --- Shareable link ---
function buildShareURL() {
    const params = new URLSearchParams();
    params.set('user', currentTargetUser);
    if (filterLang.value) params.set('lang', filterLang.value);
    if (filterCreated.value) params.set('created', filterCreated.value);
    if (filterUpdated.value) params.set('updated', filterUpdated.value);
    return `${location.origin}${location.pathname}?${params.toString()}`;
}

btnShare.addEventListener('click', async () => {
    const url = buildShareURL();
    try {
        await navigator.clipboard.writeText(url);
        setStatus('SHAREABLE LINK COPIED TO CLIPBOARD', 'success');
    } catch (e) {
        window.prompt('Copy this shareable link:', url);
    }
});

// --- Random famous developer ---
const FAMOUS_DEVS = [
    'torvalds', 'gaearon', 'sindresorhus', 'antirez', 'tj', 'yyx990803',
    'mojombo', 'defunkt', 'addyosmani', 'kentcdodds', 'getify', 'fabpot',
    'dhh', 'wycats', 'bradtraversy', 'pmndrs', 'mrdoob'
];
btnRandom.addEventListener('click', () => {
    const dev = FAMOUS_DEVS[Math.floor(Math.random() * FAMOUS_DEVS.length)];
    ghInput.value = dev;
    ghToken.value = '';
    triggerScan();
});

// --- Repo search / focus ---
function focusRepo(query) {
    query = query.trim().toLowerCase();
    if (!query) return;
    const match = Object.keys(repoPositions).find(fn => fn.toLowerCase().includes(query));
    if (!match) {
        setStatus(`NO VISIBLE REPO MATCHING "${query.toUpperCase()}"`, 'error');
        return;
    }
    const pos = repoPositions[match];
    controls.target.copy(pos);
    const offset = new THREE.Vector3(0.4, 0.6, 1).normalize().multiplyScalar(45);
    camera.position.copy(pos).add(offset);
    highlightedRepo = match;
    highlightUntil = performance.now() + 4000;
    flashBloom(3.0, 400);
    setStatus(`FOCUSED: ${match}`, 'success');
}
repoSearch.addEventListener('keydown', (e) => { if (e.key === 'Enter') focusRepo(repoSearch.value); });

// --- Help modal ---
function openHelp() { helpModal.hidden = false; }
function closeHelp() { helpModal.hidden = true; }
btnHelp.addEventListener('click', openHelp);
helpClose.addEventListener('click', closeHelp);
helpModal.addEventListener('click', (e) => { if (e.target === helpModal) closeHelp(); });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeHelp(); });

// --- Session persistence (token kept for this tab only, opt-in) ---
function persistSession(username, token) {
    try {
        sessionStorage.setItem('cf_user', username);
        if (rememberToken.checked && token && token.trim() !== '') {
            sessionStorage.setItem('cf_token', token.trim());
        } else {
            sessionStorage.removeItem('cf_token');
        }
    } catch (e) { /* storage unavailable — ignore */ }
}

// --- Deep-link + session bootstrap ---
function initFromURLAndSession() {
    const params = new URLSearchParams(location.search);
    let user = params.get('user');
    let token = '';

    try {
        const sUser = sessionStorage.getItem('cf_user');
        const sToken = sessionStorage.getItem('cf_token');
        if (!user && sUser) user = sUser;
        if (sToken) { token = sToken; rememberToken.checked = true; }
    } catch (e) { /* ignore */ }

    if (params.get('lang')) pendingFilters.lang = params.get('lang');
    if (params.get('created')) pendingFilters.created = params.get('created');
    if (params.get('updated')) pendingFilters.updated = params.get('updated');

    if (user) {
        ghInput.value = user;
        if (token) ghToken.value = token;
        triggerScan();
    }
}
initFromURLAndSession();

// --- ANIMATION LOOP ---
const clock = new THREE.Clock();
const dummyMatrix = new THREE.Matrix4();
const dummyPos = new THREE.Vector3();
const dummyQuat = new THREE.Quaternion();
const dummyScale = new THREE.Vector3();

let hoveredMeshId = -1;
let hoveredInstanceId = -1;

let loadingHidden = false;
let fpsFrames = 0;
let fpsLast = performance.now();

function animate() {
    requestAnimationFrame(animate);
    const time = clock.getElapsedTime();

    if (highlightedRepo && performance.now() > highlightUntil) highlightedRepo = null;

    const panSpeed = 2.0;
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    forward.y = 0; right.y = 0;
    forward.normalize(); right.normalize();

    if (keys.w) { camera.position.addScaledVector(forward, panSpeed); controls.target.addScaledVector(forward, panSpeed); }
    if (keys.s) { camera.position.addScaledVector(forward, -panSpeed); controls.target.addScaledVector(forward, -panSpeed); }
    if (keys.d) { camera.position.addScaledVector(right, panSpeed); controls.target.addScaledVector(right, panSpeed); }
    if (keys.a) { camera.position.addScaledVector(right, -panSpeed); controls.target.addScaledVector(right, -panSpeed); }
    if (keys.q) { camera.position.y -= panSpeed; controls.target.y -= panSpeed; }
    if (keys.e) { camera.position.y += panSpeed; controls.target.y += panSpeed; }

    // Analog joystick (touch): up = forward, sideways = strafe
    if (joyVec.x !== 0 || joyVec.y !== 0) {
        camera.position.addScaledVector(forward, -joyVec.y * panSpeed);
        controls.target.addScaledVector(forward, -joyVec.y * panSpeed);
        camera.position.addScaledVector(right, joyVec.x * panSpeed);
        controls.target.addScaledVector(right, joyVec.x * panSpeed);
    }

    controls.update();
    forestGroup.rotation.y = reducedMotion ? 0 : Math.sin(time * 0.003) * 0.03;

    for (let i = 0; i < instancedMeshes.length; i++) {
        const im = instancedMeshes[i];
        if (im.count === 0) continue;

        for (let j = 0; j < im.count; j++) {
            const data = nodeDataMap[`${i}_${j}`];
            if (!data) continue;

            data.origMatrix.decompose(dummyPos, dummyQuat, dummyScale);
            if (!reducedMotion) {
                dummyPos.y = data.baseY + Math.sin(time * 2 + data.offset) * 0.3;
                dummyQuat.x += data.rx; dummyQuat.y += data.ry;
                dummyQuat.normalize();
            }

            let nodeScale = 1;
            if (hoveredMeshId === i && hoveredInstanceId === j) nodeScale = 2.5;
            else if (highlightedRepo && data.repo === highlightedRepo) nodeScale = 1.8;
            dummyScale.set(nodeScale, nodeScale, nodeScale);

            dummyMatrix.compose(dummyPos, dummyQuat, dummyScale);
            im.setMatrixAt(j, dummyMatrix);
        }
        im.instanceMatrix.needsUpdate = true;
    }

    // Particles (static under reduced-motion)
    if (!reducedMotion) {
        const pPositions = particleSystem.geometry.attributes.position.array;
        for (let i = 0; i < particleCount; i++) {
            pPositions[i * 3 + 1] += particleVel[i];
            if (pPositions[i * 3 + 1] < 0) {
                pPositions[i * 3 + 1] = 400;
                pPositions[i * 3] = (Math.random() - 0.5) * 800;
                pPositions[i * 3 + 2] = (Math.random() - 0.5) * 800;
            }
        }
        particleSystem.geometry.attributes.position.needsUpdate = true;
    }

    // Throttled raycasting
    if (Date.now() - lastMouseTime < 100 && instancedMeshes.length > 0) {
        raycaster.setFromCamera(mouse, camera);
        const intersects = raycaster.intersectObjects(instancedMeshes);

        if (intersects.length > 0) {
            const hit = intersects[0];
            const objIndex = instancedMeshes.indexOf(hit.object);
            const instId = hit.instanceId;

            if (hoveredMeshId !== objIndex || hoveredInstanceId !== instId) {
                hoveredMeshId = objIndex;
                hoveredInstanceId = instId;

                const ud = nodeDataMap[`${objIndex}_${instId}`];
                if (ud) {
                    hoveredNodeInfo = ud;
                    const colorHex = '#' + ud.lineColorHex.toString(16).padStart(6, '0');
                    // SECURITY: all GitHub-sourced strings are HTML-escaped.
                    tooltip.innerHTML = `
                        <strong><span style="color:${colorHex}">●</span> "${escapeHTML(ud.message)}"</strong>
                        <div class="tt-row" style="margin-top: 8px;"><span class="tt-label">Repo:</span> <span class="tt-value">${escapeHTML(ud.repo)}</span></div>
                        <div class="tt-row"><span class="tt-label">Language:</span> <span class="tt-value" style="color:${colorHex}">${escapeHTML(ud.language)}</span></div>
                        <div class="tt-row"><span class="tt-label">Created:</span> <span class="tt-value">${escapeHTML(ud.created)}</span></div>
                        <div class="tt-row"><span class="tt-label">Updated:</span> <span class="tt-value">${escapeHTML(ud.updated)}</span></div>
                        <div class="tt-row"><span class="tt-label">Commit:</span> <span class="tt-value" style="color:#aaa">${escapeHTML(ud.commitHash)}</span></div>
                        <div class="tt-action">[ Click to open commit ]</div>
                    `;
                    tooltip.style.borderColor = colorHex;
                    tooltip.style.boxShadow = `0 8px 32px rgba(0,0,0,0.5), 0 0 18px ${colorHex}88`;
                    tooltip.classList.add('visible');
                    document.body.style.cursor = 'pointer';
                }
            }
        } else {
            hoveredMeshId = -1;
            hoveredInstanceId = -1;
            hoveredNodeInfo = null;
            tooltip.classList.remove('visible');
            document.body.style.cursor = 'default';
        }
    }

    composer.render();

    // Hide loading splash once the first frame is on screen.
    if (!loadingHidden) {
        loadingHidden = true;
        loadingScreen.classList.add('fade-out');
    }

    // FPS counter (~2 Hz update)
    fpsFrames++;
    const nowMs = performance.now();
    if (nowMs - fpsLast >= 500) {
        statFps.textContent = Math.round((fpsFrames * 1000) / (nowMs - fpsLast));
        fpsFrames = 0;
        fpsLast = nowMs;
    }
}
animate();

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
}, false);
