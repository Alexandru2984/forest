import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { languageColors } from "./model.js";

function seedFor(text) {
    let hash = 2166136261;
    for (const char of text) {
        hash ^= char.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}
function randomFor(text) {
    let seed = seedFor(text);
    return () => {
        seed += 0x6d2b79f5;
        let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}
function disposeObjects(root) {
    const geometries = new Set(),
        materials = new Set();
    root.traverse((object) => {
        if (object.geometry) geometries.add(object.geometry);
        for (const material of Array.isArray(object.material)
            ? object.material
            : [object.material])
            if (material) materials.add(material);
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    root.clear();
}

export function createForest(
    container,
    { tooltip, onSelect, onStatus, onFailure },
) {
    const reducedMotion = matchMedia(
        "(prefers-reduced-motion: reduce)",
    ).matches;
    const renderer = new THREE.WebGLRenderer({
        antialias: false,
        alpha: false,
        powerPreference: "low-power",
        preserveDrawingBuffer: false,
    });
    renderer.setClearColor(0x081911);
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ReinhardToneMapping;
    renderer.toneMappingExposure = 1.35;
    const canvas = renderer.domElement;
    canvas.tabIndex = 0;
    canvas.setAttribute(
        "aria-label",
        "Interactive repository forest. Drag to orbit, scroll to zoom, or use arrow keys to pan. The repository collection provides all details without 3D.",
    );
    container.append(canvas);
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x081911, 0.0025);
    const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 2500);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.maxPolarAngle = Math.PI * 0.48;
    controls.minDistance = 12;
    controls.maxDistance = 1300;
    controls.autoRotateSpeed = 0.55;
    controls.listenToKeyEvents(canvas);
    scene.add(new THREE.AmbientLight(0xc9edb3, 0.7));
    const ground = new THREE.Mesh(
        new THREE.CircleGeometry(650, 80),
        new THREE.MeshBasicMaterial({ color: 0x0a1c13 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.35;
    scene.add(ground);
    const grid = new THREE.GridHelper(900, 90, 0x4c7051, 0x284b35);
    grid.material.transparent = true;
    grid.material.opacity = 0.18;
    scene.add(grid);
    const rim = new THREE.Mesh(
        new THREE.RingGeometry(158, 158.3, 100),
        new THREE.MeshBasicMaterial({
            color: 0x56724c,
            transparent: true,
            opacity: 0.5,
            side: THREE.DoubleSide,
        }),
    );
    rim.rotation.x = -Math.PI / 2;
    rim.position.y = 0.02;
    scene.add(rim);
    const forest = new THREE.Group();
    scene.add(forest);
    const starsGeometry = new THREE.BufferGeometry(),
        starPositions = new Float32Array(700 * 3);
    const starsRandom = randomFor("forest-fireflies");
    for (let i = 0; i < 700; i++) {
        starPositions[i * 3] = (starsRandom() - 0.5) * 430;
        starPositions[i * 3 + 1] = starsRandom() * 110 + 5;
        starPositions[i * 3 + 2] = (starsRandom() - 0.5) * 430;
    }
    starsGeometry.setAttribute(
        "position",
        new THREE.BufferAttribute(starPositions, 3),
    );
    const stars = new THREE.Points(
        starsGeometry,
        new THREE.PointsMaterial({
            color: 0xbef277,
            size: 0.35,
            transparent: true,
            opacity: 0.55,
        }),
    );
    scene.add(stars);
    const selection = new THREE.Mesh(
        new THREE.RingGeometry(4.8, 5.2, 40),
        new THREE.MeshBasicMaterial({
            color: 0xe3ffa9,
            side: THREE.DoubleSide,
        }),
    );
    selection.rotation.x = -Math.PI / 2;
    selection.visible = false;
    selection.position.y = 0.2;
    forest.add(selection);
    let meshes = [],
        meshRepos = new Map(),
        positions = new Map(),
        disposed = false,
        frame = 0,
        last = 0,
        motion = 0,
        paused = reducedMotion,
        orbit = false,
        quality = "auto",
        low = false,
        composer = null,
        bloom = null,
        lastKey = "",
        extent = 100;
    function resize() {
        if (disposed) return;
        const width = Math.max(container.clientWidth, 1),
            height = Math.max(container.clientHeight, 1);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height, false);
        composer?.setSize(width, height);
    }
    function reset() {
        controls.target.set(0, 8, 0);
        const distance = Math.max(125, extent * 1.5);
        camera.position.set(distance * 0.85, distance * 0.72, distance);
        controls.update();
        selection.visible = false;
    }
    function setQuality(value) {
        quality = value;
        low =
            value === "low" ||
            (value === "auto" &&
                (matchMedia("(max-width: 760px)").matches ||
                    reducedMotion ||
                    (navigator.hardwareConcurrency || 8) <= 4));
        const ratio = Math.min(
            devicePixelRatio || 1,
            low ? 1 : value === "high" ? 2 : 1.5,
        );
        renderer.setPixelRatio(ratio);
        if (value === "high" && !composer) {
            composer = new EffectComposer(renderer);
            composer.addPass(new RenderPass(scene, camera));
            bloom = new UnrealBloomPass(
                new THREE.Vector2(1, 1),
                0.75,
                0.45,
                0.5,
            );
            composer.addPass(bloom);
        }
        if (composer) {
            composer.setPixelRatio(ratio);
            bloom.enabled = value === "high";
        }
        stars.visible = !low;
        onStatus(
            low
                ? "Low power · 24 fps cap"
                : value === "high"
                  ? "High detail · 60 fps cap"
                  : "Auto · 30 fps cap",
        );
        resize();
    }
    function setRepos(repos) {
        const key = repos
            .map(
                (repo) =>
                    `${repo.full_name}:${repo.commits.length}:${repo.stars}:${repo.language}`,
            )
            .sort()
            .join("|");
        if (lastKey === key) return;
        lastKey = key;
        forest.remove(selection);
        disposeObjects(forest);
        forest.add(selection);
        selection.visible = false;
        tooltip.hidden = true;
        meshes = [];
        meshRepos = new Map();
        positions = new Map();
        if (!repos.length) {
            reset();
            return;
        }
        // Canonical ordering and per-repository seeds keep rebuilds reproducible.
        const groups = new Map();
        for (const repo of [...repos].sort((a, b) =>
            a.full_name.localeCompare(b.full_name, "en"),
        )) {
            if (!groups.has(repo.language)) groups.set(repo.language, []);
            groups.get(repo.language).push(repo);
        }
        const totalLeaves = repos.reduce(
            (total, repo) => total + Math.max(1, repo.commits.length),
            0,
        );
        const trunks = new THREE.InstancedMesh(
            new THREE.CylinderGeometry(0.4, 0.85, 1, 5),
            new THREE.MeshBasicMaterial({ color: 0x6b8d5a }),
            repos.length,
        );
        const leaves = new THREE.InstancedMesh(
            new THREE.IcosahedronGeometry(1, 0),
            new THREE.MeshBasicMaterial({ color: 0xffffff }),
            totalLeaves,
        );
        trunks.frustumCulled = false;
        leaves.frustumCulled = false;
        forest.add(trunks, leaves);
        meshes = [trunks, leaves];
        meshRepos.set(trunks, []);
        meshRepos.set(leaves, []);
        const matrix = new THREE.Matrix4(),
            color = new THREE.Color(),
            branchPositions = [],
            branchColors = [];
        let treeIndex = 0,
            leafIndex = 0,
            sectorStart = 0;
        extent = 70;
        for (const [language, group] of [...groups.entries()].sort(
            (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
        )) {
            const slice = (group.length / repos.length) * Math.PI * 2;
            for (let i = 0; i < group.length; i++) {
                const repo = group[i],
                    random = randomFor(repo.full_name),
                    radius = 25 + Math.sqrt(i + 0.8) * 16 + random() * 10;
                const angle =
                    sectorStart +
                    slice * (0.12 + (0.76 * (i + 0.5)) / group.length);
                const x = Math.cos(angle) * radius,
                    z = Math.sin(angle) * radius,
                    height =
                        8 +
                        repo.commits.length * 0.8 +
                        Math.log2(repo.stars + 1) * 0.4;
                extent = Math.max(extent, radius + 20);
                positions.set(
                    repo.full_name,
                    new THREE.Vector3(x, height * 0.4, z),
                );
                matrix.makeScale(1, height, 1);
                matrix.setPosition(x, height / 2, z);
                trunks.setMatrixAt(treeIndex, matrix);
                meshRepos.get(trunks)[treeIndex++] = repo;
                color.set(languageColors[language] || "#a5b1a1");
                color.multiplyScalar(0.85 + random() * 0.35);
                const leafCount = Math.max(1, repo.commits.length);
                for (let j = 0; j < leafCount; j++) {
                    const y = repo.commits.length
                        ? 5 + (j / leafCount) * (height - 4)
                        : height;
                    const branchRadius = repo.commits.length
                        ? 2 + (1 - j / leafCount) * 4
                        : 0;
                    const branchAngle = j * 2.39996 + random() * 0.4;
                    const nx = x + Math.cos(branchAngle) * branchRadius,
                        nz = z + Math.sin(branchAngle) * branchRadius;
                    const scale = repo.commits.length
                        ? 0.75 + random() * 0.8
                        : 2.8;
                    matrix.makeScale(scale, scale, scale);
                    matrix.setPosition(nx, y, nz);
                    leaves.setMatrixAt(leafIndex, matrix);
                    leaves.setColorAt(leafIndex, color);
                    meshRepos.get(leaves)[leafIndex++] = repo;
                    if (repo.commits.length) {
                        branchPositions.push(x, y - 1.6, z, nx, y, nz);
                        branchColors.push(
                            color.r * 0.6,
                            color.g * 0.6,
                            color.b * 0.6,
                            color.r,
                            color.g,
                            color.b,
                        );
                    }
                }
            }
            sectorStart += slice;
        }
        trunks.instanceMatrix.needsUpdate = true;
        leaves.instanceMatrix.needsUpdate = true;
        leaves.instanceColor.needsUpdate = true;
        if (branchPositions.length) {
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute(
                "position",
                new THREE.Float32BufferAttribute(branchPositions, 3),
            );
            geometry.setAttribute(
                "color",
                new THREE.Float32BufferAttribute(branchColors, 3),
            );
            forest.add(
                new THREE.LineSegments(
                    geometry,
                    new THREE.LineBasicMaterial({
                        vertexColors: true,
                        transparent: true,
                        opacity: 0.6,
                    }),
                ),
            );
        }
        forest.updateMatrixWorld(true);
        reset();
    }
    function focus(fullName) {
        const position = positions.get(fullName);
        if (!position) return;
        const world = forest.localToWorld(position.clone());
        controls.target.copy(world);
        camera.position.copy(world).add(new THREE.Vector3(24, 26, 38));
        selection.position.set(position.x, 0.2, position.z);
        selection.visible = true;
        controls.update();
    }
    const raycaster = new THREE.Raycaster(),
        pointer = new THREE.Vector2();
    let down = null,
        lastHover = 0;
    function hit(event) {
        const rect = canvas.getBoundingClientRect();
        pointer.set(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            (-(event.clientY - rect.top) / rect.height) * 2 + 1,
        );
        raycaster.setFromCamera(pointer, camera);
        const intersection = raycaster.intersectObjects(meshes, false)[0];
        return intersection
            ? meshRepos.get(intersection.object)?.[intersection.instanceId]
            : null;
    }
    function pointerDown(event) {
        down = { x: event.clientX, y: event.clientY, moved: false };
        tooltip.hidden = true;
    }
    function pointerMove(event) {
        if (
            down &&
            Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5
        )
            down.moved = true;
        if (
            event.pointerType === "touch" ||
            down ||
            performance.now() - lastHover < 70
        )
            return;
        lastHover = performance.now();
        const repo = hit(event);
        tooltip.hidden = !repo;
        if (repo) {
            tooltip.textContent = `${repo.name} · ${repo.language} · ${repo.commits.length} sampled commits`;
            const rect = canvas.getBoundingClientRect();
            tooltip.style.left = `${Math.max(8, Math.min(rect.width - 240, event.clientX - rect.left + 12))}px`;
            tooltip.style.top = `${Math.max(8, Math.min(rect.height - 70, event.clientY - rect.top - 40))}px`;
        }
        canvas.style.cursor = repo ? "pointer" : "grab";
    }
    function pointerUp(event) {
        if (down && !down.moved) {
            const repo = hit(event);
            if (repo) {
                focus(repo.full_name);
                onSelect(repo);
            }
        }
        down = null;
    }
    function pointerLeave() {
        tooltip.hidden = true;
    }
    function pointerCancel() {
        down = null;
        tooltip.hidden = true;
    }
    canvas.addEventListener("pointerdown", pointerDown);
    canvas.addEventListener("pointermove", pointerMove);
    canvas.addEventListener("pointerup", pointerUp);
    canvas.addEventListener("pointerleave", pointerLeave);
    canvas.addEventListener("pointercancel", pointerCancel);
    function contextLost(event) {
        event.preventDefault();
        if (!disposed)
            onFailure(
                "The browser released the 3D context. Your collection is still available; retry the scene when ready.",
            );
    }
    canvas.addEventListener("webglcontextlost", contextLost);
    function draw(now) {
        frame = 0;
        if (disposed || document.hidden) return;
        frame = requestAnimationFrame(draw);
        const fps = low ? 24 : quality === "high" ? 60 : 30;
        if (now - last < 1000 / fps) return;
        const delta = Math.min((now - last) / 1000, 0.08);
        last = now;
        if (!paused) {
            motion += delta;
            forest.rotation.y = Math.sin(motion * 0.06) * 0.025;
            stars.rotation.y = motion * 0.008;
        }
        controls.autoRotate = orbit && !paused;
        controls.update();
        if (composer && quality === "high") composer.render();
        else renderer.render(scene, camera);
    }
    function visibility() {
        if (document.hidden) {
            cancelAnimationFrame(frame);
            frame = 0;
            down = null;
            tooltip.hidden = true;
        } else if (!frame && !disposed) {
            last = performance.now();
            frame = requestAnimationFrame(draw);
        }
    }
    document.addEventListener("visibilitychange", visibility);
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    setQuality("auto");
    reset();
    frame = requestAnimationFrame(draw);
    return {
        setRepos,
        setQuality,
        reset,
        focus,
        setPaused(value) {
            paused = value;
        },
        setOrbit(value) {
            orbit = value;
        },
        snapshot(filename) {
            if (composer && quality === "high") composer.render();
            else renderer.render(scene, camera);
            const url = canvas.toDataURL("image/png");
            const link = document.createElement("a");
            link.href = url;
            link.download = filename;
            document.body.append(link);
            link.click();
            link.remove();
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            cancelAnimationFrame(frame);
            observer.disconnect();
            document.removeEventListener("visibilitychange", visibility);
            canvas.removeEventListener("webglcontextlost", contextLost);
            controls.dispose();
            composer?.dispose();
            bloom?.dispose();
            disposeObjects(scene);
            renderer.dispose();
            renderer.forceContextLoss();
            canvas.remove();
            tooltip.hidden = true;
        },
    };
}
