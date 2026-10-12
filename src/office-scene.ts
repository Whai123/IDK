import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Agent, DepartmentId, Task, TaskStatus, WorkspaceState } from './lib/types.ts';

export type OfficeSelection = { kind: 'agent' | 'department' | 'task'; id: string };
export interface OfficeSceneController {
  update(state: WorkspaceState): void;
  focus(selection: OfficeSelection): void;
  resetView(): void;
  setMotion(enabled: boolean): void;
  dispose(): void;
}

type Zone = { id: DepartmentId; x: number; z: number; width: number; depth: number; color: string };
const zones: Zone[] = [
  { id: 'product', x: -8, z: -6.1, width: 6.2, depth: 4.9, color: '#9a90d3' },
  { id: 'design', x: 0, z: -6.1, width: 6.2, depth: 4.9, color: '#d9a26b' },
  { id: 'engineering', x: 8, z: -6.1, width: 6.4, depth: 4.9, color: '#76a7c4' },
  { id: 'marketing', x: -8, z: .5, width: 6.4, depth: 5.5, color: '#d698ac' },
  { id: 'sales', x: 8, z: .5, width: 6.4, depth: 5.5, color: '#bdab81' },
  { id: 'support', x: -7.3, z: 7.1, width: 7.3, depth: 4.5, color: '#83b4a6' },
  { id: 'operations', x: 7.3, z: 7.1, width: 7.3, depth: 4.5, color: '#a2b786' },
];
const statusColors: Record<TaskStatus, string> = {
  proposed: '#a4a7b7', queued: '#80a5bd', running: '#59b8ad', waiting: '#e6ad56',
  review: '#a895d2', done: '#88b77c', paused: '#9cabb2', dismissed: '#c2c4c5', failed: '#dc8579',
};

class Resources {
  private geometries = new Set<THREE.BufferGeometry>();
  private materials = new Set<THREE.Material>();
  private textures = new Set<THREE.Texture>();
  private materialCache = new Map<string, THREE.MeshStandardMaterial>();
  geometry<T extends THREE.BufferGeometry>(geometry: T): T { this.geometries.add(geometry); return geometry; }
  material(color: string, options: Partial<THREE.MeshStandardMaterialParameters> = {}): THREE.MeshStandardMaterial {
    const key = color + JSON.stringify(options);
    let material = this.materialCache.get(key);
    if (!material) { material = new THREE.MeshStandardMaterial({ color, roughness: .76, metalness: .03, ...options }); this.materials.add(material); this.materialCache.set(key, material); }
    return material;
  }
  ownMaterial<T extends THREE.Material>(material: T): T { this.materials.add(material); return material; }
  texture<T extends THREE.Texture>(texture: T): T { this.textures.add(texture); return texture; }
  dispose(): void { this.geometries.forEach(item => item.dispose()); this.materials.forEach(item => item.dispose()); this.textures.forEach(item => item.dispose()); this.geometries.clear(); this.materials.clear(); this.textures.clear(); this.materialCache.clear(); }
}

function box(resources: Resources, parent: THREE.Object3D, size: [number, number, number], position: [number, number, number], color: string, options: Partial<THREE.MeshStandardMaterialParameters> = {}): THREE.Mesh {
  const mesh = new THREE.Mesh(resources.geometry(new THREE.BoxGeometry(...size)), resources.material(color, options));
  mesh.position.set(...position); mesh.castShadow = true; mesh.receiveShadow = true; parent.add(mesh); return mesh;
}

function cylinder(resources: Resources, parent: THREE.Object3D, radius: number, height: number, position: [number, number, number], color: string, topRadius = radius): THREE.Mesh {
  const mesh = new THREE.Mesh(resources.geometry(new THREE.CylinderGeometry(topRadius, radius, height, 24)), resources.material(color));
  mesh.position.set(...position); mesh.castShadow = true; mesh.receiveShadow = true; parent.add(mesh); return mesh;
}

function sphere(resources: Resources, parent: THREE.Object3D, radius: number, position: [number, number, number], color: string): THREE.Mesh {
  const mesh = new THREE.Mesh(resources.geometry(new THREE.SphereGeometry(radius, 16, 12)), resources.material(color));
  mesh.position.set(...position); mesh.castShadow = true; parent.add(mesh); return mesh;
}

function roundedPlate(resources: Resources, parent: THREE.Object3D, width: number, depth: number, height: number, radius: number, position: [number, number, number], color: string): THREE.Mesh {
  const shape = new THREE.Shape(), x = -width / 2, y = -depth / 2;
  shape.moveTo(x + radius, y); shape.lineTo(x + width - radius, y); shape.quadraticCurveTo(x + width, y, x + width, y + radius);
  shape.lineTo(x + width, y + depth - radius); shape.quadraticCurveTo(x + width, y + depth, x + width - radius, y + depth);
  shape.lineTo(x + radius, y + depth); shape.quadraticCurveTo(x, y + depth, x, y + depth - radius);
  shape.lineTo(x, y + radius); shape.quadraticCurveTo(x, y, x + radius, y);
  const geometry = resources.geometry(new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: true, bevelSize: .025, bevelThickness: .02, bevelSegments: 2, curveSegments: 8 }));
  geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, resources.material(color)); mesh.position.set(...position); mesh.castShadow = true; mesh.receiveShadow = true; parent.add(mesh); return mesh;
}

function label(resources: Resources, text: string, subtext: string, color: string, width: number, position: [number, number, number], solid = true): THREE.Sprite {
  const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 192;
  const context = canvas.getContext('2d');
  if (context) {
    if (solid) { context.fillStyle = '#fffdf8'; context.beginPath(); context.roundRect(8, 8, 624, 176, 30); context.fill(); }
    context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillStyle = color; context.font = '600 64px system-ui, sans-serif'; context.fillText(text.slice(0, 24), 320, subtext ? 74 : 98, 595);
    if (subtext) { context.fillStyle = '#52645e'; context.font = '400 34px system-ui, sans-serif'; context.fillText(subtext.slice(0, 38), 320, 136, 590); }
  }
  const texture = resources.texture(new THREE.CanvasTexture(canvas)); texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(resources.ownMaterial(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false })));
  sprite.scale.set(width, width * .3, 1); sprite.position.set(...position); return sprite;
}

function plant(resources: Resources, parent: THREE.Object3D, x: number, z: number, scale = 1): void {
  const group = new THREE.Group(); group.position.set(x, 0, z); group.scale.setScalar(scale); parent.add(group);
  cylinder(resources, group, .25, .42, [0, .22, 0], '#dfcbb7', .31);
  cylinder(resources, group, .045, .85, [0, .78, 0], '#64836c');
  for (let index = 0; index < 7; index++) {
    const angle = index * 2.4;
    const leaf = sphere(resources, group, .22, [Math.cos(angle) * .23, .75 + index * .075, Math.sin(angle) * .23], index % 2 ? '#8bab84' : '#698d73');
    leaf.scale.set(.8, 1.7, .42); leaf.rotation.z = Math.cos(angle) * .65;
  }
}

function makeDesk(resources: Resources, parent: THREE.Object3D, x: number, z: number, accent: string): void {
  const desk = new THREE.Group(); desk.position.set(x, 0, z); parent.add(desk);
  roundedPlate(resources, desk, 1.9, 1.05, .12, .16, [0, 1, 0], '#e9d3b7');
  for (const dx of [-.72, .72]) box(resources, desk, [.1, .97, .1], [dx, .48, -.24], '#7e8e8b');
  box(resources, desk, [1.4, .08, .66], [0, .22, -.2], '#acb6ad');
  box(resources, desk, [.08, .31, .07], [0, 1.25, -.27], '#52656b');
  const screen = box(resources, desk, [.91, .57, .075], [0, 1.53, -.31], '#374e54');
  screen.rotation.x = -.09;
  box(resources, desk, [.78, .43, .016], [0, 1.53, -.261], '#d2e5e5', { emissive: '#b0d3d1', emissiveIntensity: .18 });
  box(resources, desk, [.09, .32, .019], [-.3, 1.53, -.248], accent);
  for (let index = 0; index < 3; index++) box(resources, desk, [.26 + index * .085, .025, .02], [.05, 1.64 - index * .085, -.248], index === 0 ? '#77a3ac' : '#a8c3c4');
  roundedPlate(resources, desk, .6, .21, .015, .035, [0, 1.13, .25], '#607276');
  cylinder(resources, desk, .105, .15, [.66, 1.17, .13], '#fff9ee');
  cylinder(resources, desk, .11, .55, [0, .3, .83], '#6c7e7c');
  roundedPlate(resources, desk, .64, .6, .1, .12, [0, .55, .82], '#728e89');
  const back = box(resources, desk, [.62, .65, .13], [0, .96, 1.1], '#728e89'); back.rotation.x = -.12;
  for (const angle of [0, 2.1, 4.2]) {
    const leg = box(resources, desk, [.6, .045, .06], [0, .06, .83], '#566963'); leg.rotation.y = angle;
  }
}

function makeAvatar(resources: Resources, parent: THREE.Object3D, agent: Agent, x: number, z: number, index: number, color: string): THREE.Group {
  const group = new THREE.Group(); group.position.set(x, 0, z + .82); group.userData.selection = { kind: 'agent', id: agent.id } satisfies OfficeSelection; group.userData.title = `${agent.name} · ${agent.role} · ${agent.provider === 'claude' ? 'Claude' : 'GPT / Codex'}`; parent.add(group);
  const skin = ['#d3a181', '#edd0b1', '#a77559', '#d9b294'][index % 4];
  const hair = ['#435454', '#755644', '#474451', '#b18b64'][index % 4];
  const body = new THREE.Mesh(resources.geometry(new THREE.CapsuleGeometry(.23, .28, 4, 12)), resources.material(agent.enabled ? color : '#a9afac'));
  body.position.y = .91; body.castShadow = true; group.add(body);
  sphere(resources, group, .245, [0, 1.44, 0], skin);
  const cap = new THREE.Mesh(resources.geometry(new THREE.SphereGeometry(.252, 16, 8, 0, Math.PI * 2, 0, Math.PI * .56)), resources.material(hair)); cap.position.y = 1.46; cap.castShadow = true; group.add(cap);
  if (index % 3 === 1) { const bun = sphere(resources, group, .13, [.12, 1.63, -.13], hair); bun.scale.y = 1.1; }
  for (const dx of [-.085, .085]) sphere(resources, group, .022, [dx, 1.45, .225], '#394345');
  const nose = sphere(resources, group, .035, [0, 1.4, .244], skin); nose.scale.z = .9;
  if (/quality|qa|analyst|engineer/i.test(agent.role)) {
    for (const dx of [-.086, .086]) box(resources, group, [.125, .073, .022], [dx, 1.45, .247], '#475d61', { transparent: true, opacity: .64 });
    box(resources, group, [.065, .018, .018], [0, 1.45, .25], '#475d61');
  }
  for (const dx of [-.2, .2]) {
    const arm = box(resources, group, [.13, .39, .14], [dx, .88, .045], agent.enabled ? color : '#a9afac'); arm.rotation.z = dx > 0 ? -.21 : .21;
    box(resources, group, [.16, .22, .22], [dx * .6, .48, -.08], '#455b61');
    box(resources, group, [.18, .085, .29], [dx * .6, .34, -.06], '#4c5e5e');
  }
  const provider = box(resources, group, [.145, .145, .026], [.14, 1.02, .205], agent.provider === 'claude' ? '#e7ba98' : '#b7d5c9'); provider.rotation.z = .12;
  const name = label(resources, agent.name, agent.enabled ? (agent.provider === 'claude' ? 'CLAUDE' : 'GPT / CODEX') : 'DISABLED', '#526662', 1.55, [0, 2.06, 0]); group.add(name);
  return group;
}

function fallback(container: HTMLElement): OfficeSceneController {
  const element = document.createElement('div'); element.dataset.testid = 'office-webgl-fallback'; element.setAttribute('role', 'status');
  element.style.cssText = 'display:grid;place-content:center;gap:12px;height:100%;min-height:350px;padding:32px;text-align:center;color:#52635e;background:linear-gradient(135deg,#f3f0e9,#e6efeb);border-radius:20px;';
  const title = document.createElement('strong'); title.textContent = 'The 3D office needs WebGL'; title.style.fontSize = '22px';
  const detail = document.createElement('p'); detail.textContent = 'Use the team list and work details below, or try a browser with graphics acceleration enabled.'; detail.style.cssText = 'max-width:420px;line-height:1.6;margin:0;';
  element.append(title, detail); container.append(element);
  return { update: () => {}, focus: () => {}, resetView: () => {}, setMotion: () => {}, dispose: () => element.remove() };
}

/** A visual projection of recorded workspace state. It never runs agents or invents conversations. */
export function createOfficeScene(container: HTMLElement, onSelect: (selection: OfficeSelection) => void): OfficeSceneController {
  let renderer: THREE.WebGLRenderer;
  try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'low-power' }); }
  catch { return fallback(container); }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.16;
  const canvas = renderer.domElement; canvas.dataset.testid = 'office-canvas'; canvas.dataset.rendererReady = 'false'; canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', 'Interactive 3D office. Team and work details are also available in the accessible list.'); canvas.style.cssText = 'width:100%;height:100%;display:block;touch-action:none;border-radius:inherit;'; container.append(canvas);
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#eaece6');
  const camera = new THREE.OrthographicCamera(-18, 18, 13.5, -13.5, .1, 120);
  let cameraTransition: { fromTarget: THREE.Vector3; toTarget: THREE.Vector3; fromPosition: THREE.Vector3; toPosition: THREE.Vector3; fromZoom: number; toZoom: number; startedAt: number } | null = null;
  const controls = new OrbitControls(camera, canvas); controls.enableDamping = true; controls.dampingFactor = .09; controls.maxPolarAngle = Math.PI * .47; controls.minPolarAngle = Math.PI * .13; controls.minZoom = .65; controls.maxZoom = 2.7; controls.enablePan = true; controls.panSpeed = .65; controls.rotateSpeed = .55;
  const resetView = () => { cameraTransition = null; camera.position.set(25, 27, 32); camera.zoom = 1.12; controls.target.set(0, .2, 0); camera.updateProjectionMatrix(); controls.update(); };
  resetView();
  const ambient = new THREE.HemisphereLight('#fff9ec', '#9caaa2', 2.3); scene.add(ambient);
  const sunlight = new THREE.DirectionalLight('#fff2d9', 3.2); sunlight.position.set(-12, 26, 14); sunlight.castShadow = true; sunlight.shadow.mapSize.set(2048, 2048); sunlight.shadow.camera.left = -21; sunlight.shadow.camera.right = 21; sunlight.shadow.camera.top = 20; sunlight.shadow.camera.bottom = -20; sunlight.shadow.normalBias = .035; sunlight.shadow.bias = -.0001; scene.add(sunlight);
  const fill = new THREE.DirectionalLight('#dbeef0', 1.2); fill.position.set(18, 15, -15); scene.add(fill);
  const staticResources = new Resources(), staticGroup = new THREE.Group(); scene.add(staticGroup);
  roundedPlate(staticResources, staticGroup, 26, 23, .5, .6, [0, -.56, 0], '#9caea6');
  roundedPlate(staticResources, staticGroup, 25.85, 22.85, .12, .6, [0, -.06, 0], '#f4eee1');
  for (let index = -5; index <= 5; index++) box(staticResources, staticGroup, [25, .004, .014], [0, .069, index * 2], '#e6dece');
  box(staticResources, staticGroup, [25.3, .6, .22], [0, .38, -11.05], '#bfcec5');
  box(staticResources, staticGroup, [.22, .6, 21.8], [-12.4, .38, 0], '#bfcec5');
  for (let index = -2; index <= 2; index++) {
    box(staticResources, staticGroup, [3.8, 2.6, .07], [index * 4.7, 2, -11.08], '#c1dad8', { transparent: true, opacity: .36, metalness: .18, roughness: .17 });
    box(staticResources, staticGroup, [.065, 3.2, .09], [index * 4.7 - 1.95, 1.7, -11.04], '#a1b6ad');
    box(staticResources, staticGroup, [4, .07, .13], [index * 4.7, 3.32, -11.04], '#a1b6ad');
  }
  for (const [x, z, scale] of [[-11.6, -9.7, 1.25], [11.7, -9.7, 1.2], [-11.7, 9.8, 1.15], [11.7, 9.8, 1.1], [-2.3, 3, .9], [2.3, 3, .9]]) plant(staticResources, staticGroup, x, z, scale);
  // Shared founder hub, with physical meeting seats and a small product board.
  cylinder(staticResources, staticGroup, 2.05, .05, [0, .1, .8], '#ddd9c9');
  cylinder(staticResources, staticGroup, .46, .88, [0, .55, .8], '#a0aaa0');
  cylinder(staticResources, staticGroup, 1.34, .16, [0, 1.03, .8], '#e1c49f');
  for (let index = 0; index < 4; index++) {
    const angle = index * Math.PI / 2 + Math.PI / 4, x = Math.cos(angle) * 1.75, z = .8 + Math.sin(angle) * 1.75;
    cylinder(staticResources, staticGroup, .3, .43, [x, .31, z], '#9bafa6');
    roundedPlate(staticResources, staticGroup, .67, .63, .1, .18, [x, .57, z], '#879f95');
  }
  box(staticResources, staticGroup, [.58, .06, .4], [-.3, 1.15, .8], '#6a8580');
  box(staticResources, staticGroup, [.41, .025, .28], [.5, 1.15, .65], '#fff7e7');
  cylinder(staticResources, staticGroup, .1, .14, [.43, 1.23, 1.13], '#d7aa82');
  // A lounge and book shelf make the model read as an office, rather than a chart.
  roundedPlate(staticResources, staticGroup, 3.25, 1.04, .36, .24, [0, .45, 8.65], '#c9a785');
  box(staticResources, staticGroup, [3.2, .6, .2], [0, .96, 9.04], '#c9a785');
  for (const x of [-1.02, 0, 1.02]) roundedPlate(staticResources, staticGroup, .9, .8, .12, .12, [x, .82, 8.57], '#dbc0a0');
  roundedPlate(staticResources, staticGroup, 2.1, .8, .12, .22, [0, .58, 6.93], '#d8c5a9');
  box(staticResources, staticGroup, [2.05, .54, .07], [0, .27, 6.93], '#8a9c93');
  box(staticResources, staticGroup, [.5, 1.62, 2.65], [-12, .83, -5.5], '#a0b1a5');
  for (let shelf = 0; shelf < 3; shelf++) {
    box(staticResources, staticGroup, [.55, .07, 2.5], [-12, .3 + shelf * .5, -5.5], '#ced4c6');
    for (let book = 0; book < 5; book++) box(staticResources, staticGroup, [.25, .32 + (book % 2) * .06, .18], [-11.85, .51 + shelf * .5, -6.4 + book * .36], ['#b58e76', '#85a6a4', '#c8b977', '#b39bb2', '#89988a'][book]);
  }

  let dynamicGroup = new THREE.Group(), dynamicResources = new Resources(); scene.add(dynamicGroup);
  let animatedLights: Array<{ mesh: THREE.Mesh; base: number }> = [];
  let animatedFlows: Array<{ mesh: THREE.Mesh; curve: THREE.CatmullRomCurve3; offset: number }> = [];
  let focusPositions = new Map<string, THREE.Vector3>();
  let focusedSelection: OfficeSelection | null = null;
  const selectionRing = new THREE.Mesh(staticResources.geometry(new THREE.RingGeometry(.45, .56, 40)), staticResources.material('#6b9f8d', { transparent: true, opacity: .6, side: THREE.DoubleSide })); selectionRing.rotation.x = -Math.PI / 2; selectionRing.visible = false; scene.add(selectionRing);
  let lastSignature = '', disposed = false, motionEnabled = true, frame = 0, rendering = false, contextUnavailable = false;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const tooltip = document.createElement('div'); tooltip.setAttribute('aria-hidden', 'true'); tooltip.style.cssText = 'position:absolute;display:none;pointer-events:none;max-width:240px;padding:9px 12px;border:1px solid #d9e2dc;border-radius:10px;background:#fffdf8ed;color:#3e5751;font:12px/1.4 system-ui;box-shadow:0 6px 24px #344b4520;z-index:3;'; container.append(tooltip);
  const graphicsNotice = document.createElement('div'); graphicsNotice.hidden = true; graphicsNotice.setAttribute('role', 'status'); graphicsNotice.dataset.testid = 'office-context-status'; graphicsNotice.textContent = '3D graphics are temporarily unavailable. Use the team list while your browser restores the scene.'; graphicsNotice.style.cssText = 'position:absolute;bottom:18px;left:18px;right:18px;padding:14px 18px;border:1px solid #d8ded2;border-radius:12px;background:#fffaf1ef;color:#675842;font:13px/1.5 system-ui;z-index:4;'; container.append(graphicsNotice);
  let currentAccessibleLabel = canvas.getAttribute('aria-label') || '';
  const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
  const pick = (event: PointerEvent): THREE.Object3D | null => {
    const bounds = canvas.getBoundingClientRect(); if (!bounds.width || !bounds.height) return null;
    pointer.set((event.clientX - bounds.left) / bounds.width * 2 - 1, -(event.clientY - bounds.top) / bounds.height * 2 + 1); raycaster.setFromCamera(pointer, camera);
    for (const hit of raycaster.intersectObject(dynamicGroup, true)) {
      let object: THREE.Object3D | null = hit.object;
      while (object && object !== dynamicGroup) { if (object.userData.selection) return object; object = object.parent; }
    }
    return null;
  };
  let down: { x: number; y: number } | null = null;
  const pointerDown = (event: PointerEvent) => { down = { x: event.clientX, y: event.clientY }; };
  const pointerUp = (event: PointerEvent) => {
    if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) < 6) { const object = pick(event); if (object) onSelect(object.userData.selection as OfficeSelection); }
    down = null;
  };
  const pointerMove = (event: PointerEvent) => {
    const object = pick(event); canvas.style.cursor = object ? 'pointer' : 'grab';
    if (!object || down) { tooltip.style.display = 'none'; return; }
    const bounds = container.getBoundingClientRect(); tooltip.textContent = String(object.userData.title || 'View details'); tooltip.style.display = 'block'; tooltip.style.left = `${Math.min(Math.max(10, event.clientX - bounds.left + 14), Math.max(10, bounds.width - 245))}px`; tooltip.style.top = `${Math.max(8, event.clientY - bounds.top - 45)}px`;
  };
  const pointerLeave = () => { down = null; tooltip.style.display = 'none'; canvas.style.cursor = 'grab'; };
  canvas.addEventListener('pointerdown', pointerDown); canvas.addEventListener('pointerup', pointerUp); canvas.addEventListener('pointermove', pointerMove); canvas.addEventListener('pointerleave', pointerLeave);

  const render = (time = 0) => {
    if (disposed || rendering || contextUnavailable || document.hidden || !container.isConnected) return;
    rendering = true;
    const animate = motionEnabled && !reduced.matches;
    if (cameraTransition) {
      const progress = animate ? Math.min(1, Math.max(0, (time - cameraTransition.startedAt) / 550)) : 1;
      const eased = 1 - Math.pow(1 - progress, 3);
      controls.target.lerpVectors(cameraTransition.fromTarget, cameraTransition.toTarget, eased); camera.position.lerpVectors(cameraTransition.fromPosition, cameraTransition.toPosition, eased); camera.zoom = THREE.MathUtils.lerp(cameraTransition.fromZoom, cameraTransition.toZoom, eased); camera.updateProjectionMatrix();
      if (progress === 1) cameraTransition = null;
    }
    controls.enableDamping = animate && !cameraTransition;
    controls.update();
    if (animate) {
      for (const light of animatedLights) light.mesh.scale.setScalar(light.base * (1 + Math.sin(time * .0023) * .09));
      for (const flow of animatedFlows) flow.mesh.position.copy(flow.curve.getPointAt((time * .00011 + flow.offset) % 1));
    }
    try { renderer.render(scene, camera); canvas.dataset.rendererReady = 'true'; }
    finally { rendering = false; }
  };
  const canRun = () => !disposed && !contextUnavailable && container.isConnected && !document.hidden && motionEnabled && !reduced.matches;
  const tick = (time: number) => { frame = 0; if (!canRun()) return; render(time); frame = requestAnimationFrame(tick); };
  const syncFrame = () => { if (frame) { cancelAnimationFrame(frame); frame = 0; } if (disposed) return; if (!document.hidden) render(performance.now()); if (canRun()) frame = requestAnimationFrame(tick); };
  const changed = () => { if (!canRun() && !document.hidden) render(performance.now()); };
  controls.addEventListener('change', changed);
  const interruptFocus = () => { cameraTransition = null; };
  controls.addEventListener('start', interruptFocus);
  const resize = () => {
    if (disposed) return;
    const width = Math.max(1, container.clientWidth), height = Math.max(1, container.clientHeight);
    renderer.setSize(width, height, false); const aspect = width / height; const halfHeight = Math.max(13.5, 20.25 / aspect);
    camera.left = -halfHeight * aspect; camera.right = halfHeight * aspect; camera.top = halfHeight; camera.bottom = -halfHeight; camera.updateProjectionMatrix();
    if (container.isConnected && width > 1 && height > 1) render(performance.now());
  };
  const observer = new ResizeObserver(resize); observer.observe(container);
  const visible = () => syncFrame(); document.addEventListener('visibilitychange', visible); reduced.addEventListener('change', visible);
  const contextLost = (event: Event) => { event.preventDefault(); contextUnavailable = true; graphicsNotice.hidden = false; tooltip.style.display = 'none'; canvas.dataset.rendererReady = 'false'; canvas.setAttribute('aria-label', '3D graphics are temporarily unavailable. Use the accessible team list.'); if (frame) cancelAnimationFrame(frame); frame = 0; };
  const contextRestored = () => { contextUnavailable = false; graphicsNotice.hidden = true; canvas.setAttribute('aria-label', currentAccessibleLabel); resize(); syncFrame(); };
  canvas.addEventListener('webglcontextlost', contextLost); canvas.addEventListener('webglcontextrestored', contextRestored);

  const update = (state: WorkspaceState) => {
    if (disposed) return;
    currentAccessibleLabel = `${state.mode === 'demo' ? 'Sample 3D office replay; no agents are running.' : '3D office showing recorded live workspace status.'} Rotate or zoom the office; choose an agent, department or work light. An accessible team list is available below.`;
    if (!contextUnavailable) canvas.setAttribute('aria-label', currentAccessibleLabel);
    canvas.dataset.mode = state.mode;
    const signature = JSON.stringify([state.mode, state.departments.map(item => [item.id, item.name, item.color]), state.agents.map(item => [item.id, item.name, item.role, item.provider, item.enabled, item.departmentId]), state.tasks.map(item => [item.id, item.title, item.departmentId, item.agentId, item.status, item.dependsOn, item.requiresDirection, item.handoff, !!item.artifact.trim(), item.evidence.length, !!item.preview?.html]), state.decisions.filter(item => item.status === 'open').length]);
    if (signature === lastSignature) { resize(); syncFrame(); return; }
    lastSignature = signature; scene.remove(dynamicGroup); dynamicResources.dispose(); dynamicResources = new Resources(); dynamicGroup = new THREE.Group(); scene.add(dynamicGroup); animatedLights = []; animatedFlows = []; focusPositions = new Map();
    const resources = dynamicResources, taskPositions = new Map<string, THREE.Vector3>(), agentPositions = new Map<string, THREE.Vector3>();
    let agentCount = 0, taskCount = 0;
    for (const zone of zones) {
      const department = state.departments.find(item => item.id === zone.id), accent = /^#[0-9a-f]{3,8}$/i.test(department?.color ?? '') ? department!.color : zone.color;
      const team = state.agents.filter(item => item.departmentId === zone.id), teamVisible = team.slice(0, 12);
      const tasks = state.tasks.filter(item => item.departmentId === zone.id && item.status !== 'dismissed'), visibleTasks = tasks.slice(0, 8);
      const group = new THREE.Group(); group.position.set(zone.x, 0, zone.z); group.userData.selection = { kind: 'department', id: zone.id } satisfies OfficeSelection; group.userData.title = `${department?.name || zone.id} · ${team.length} agents · ${tasks.length} tasks`; dynamicGroup.add(group);
      focusPositions.set(`department:${zone.id}`, new THREE.Vector3(zone.x, .8, zone.z));
      const rugColor = `#${new THREE.Color(accent).lerp(new THREE.Color('#f8f4ea'), .77).getHexString()}`;
      roundedPlate(resources, group, zone.width, zone.depth, .045, .38, [0, .08, 0], rugColor);
      const strip = box(resources, group, [zone.width - .8, .025, .07], [0, .15, -zone.depth / 2 + .2], accent); strip.castShadow = false;
      const title = label(resources, department?.name || zone.id, `${team.length} ${team.length === 1 ? 'agent' : 'agents'}  ·  ${tasks.length} work items`, '#31463e', 3.65, [0, 3.02, -zone.depth / 2 + .16]); group.add(title);
      if (!teamVisible.length) makeDesk(resources, group, 0, -.25, accent);
      const columns = teamVisible.length <= 3 ? Math.max(1, teamVisible.length) : Math.min(4, Math.ceil(Math.sqrt(teamVisible.length)));
      const rows = Math.ceil(teamVisible.length / columns);
      teamVisible.forEach((agent, index) => {
        const column = index % columns, row = Math.floor(index / columns);
        const x = (column - (columns - 1) / 2) * Math.min(2.05, (zone.width - 1.4) / columns), z = rows > 1 ? (row - (rows - 1) / 2) * 1.9 - .45 : -.35;
        const station = new THREE.Group(); station.position.set(x, 0, z); station.userData.selection = { kind: 'agent', id: agent.id } satisfies OfficeSelection; station.userData.title = `${agent.name} · ${agent.role}`; if (columns >= 3 || rows > 2) station.scale.setScalar(columns > 3 ? .63 : .86); group.add(station);
        makeDesk(resources, station, 0, 0, accent); const avatar = makeAvatar(resources, station, agent, 0, 0, agentCount, accent); agentCount++;
        agentPositions.set(agent.id, new THREE.Vector3(zone.x + x, .5, zone.z + z));
        focusPositions.set(`agent:${agent.id}`, new THREE.Vector3(zone.x + x, 1.1, zone.z + z + .7));
        const ownedTasks = tasks.filter(task => task.agentId === agent.id), active = ownedTasks.find(task => task.status === 'running') || ownedTasks.find(task => task.status === 'waiting') || ownedTasks.find(task => task.status === 'review') || ownedTasks[0];
        const color = active ? statusColors[active.status] : '#bdc7bd';
        const light = sphere(resources, avatar, .1, [.38, 1.83, 0], color); const material = light.material as THREE.MeshStandardMaterial; material.emissive.set(color); material.emissiveIntensity = active?.status === 'running' ? .65 : .2;
        if (active?.status === 'running') animatedLights.push({ mesh: light, base: 1 });
      });
      visibleTasks.forEach((task, index) => {
        const x = (index - (visibleTasks.length - 1) / 2) * .44, z = zone.depth / 2 - .18;
        const hasDeliverable = !!task.artifact.trim() || task.evidence.length > 0 || !!task.preview?.html;
        const marker = new THREE.Group(); marker.position.set(x, 0, z); marker.userData.selection = { kind: 'task', id: task.id } satisfies OfficeSelection; marker.userData.title = `${task.title} · ${task.status}${hasDeliverable ? ` · ${task.source === 'sample' ? 'sample ' : ''}deliverable` : ''}`; group.add(marker);
        if (hasDeliverable) {
          box(resources, marker, [.27, .33, .038], [0, .5, -.075], '#fffdf4');
          box(resources, marker, [.19, .024, .018], [0, .58, -.046], statusColors[task.status]);
          box(resources, marker, [.16, .019, .018], [-.015, .52, -.045], '#a7b9af');
        }
        cylinder(resources, marker, .17, .1, [0, .2, 0], '#fffaf0');
        const bulb = sphere(resources, marker, .125, [0, .4, 0], statusColors[task.status]); const material = bulb.material as THREE.MeshStandardMaterial; material.emissive.set(statusColors[task.status]); material.emissiveIntensity = task.status === 'running' ? .7 : .18;
        if (task.status === 'running') animatedLights.push({ mesh: bulb, base: 1 });
        taskPositions.set(task.id, new THREE.Vector3(zone.x + x, .42, zone.z + z)); taskCount++;
        focusPositions.set(`task:${task.id}`, new THREE.Vector3(zone.x + x, .65, zone.z + z));
      });
      if (team.length > teamVisible.length) group.add(label(resources, `+${team.length - teamVisible.length} more agents`, 'Full team in the list', '#697a73', 2.5, [0, .8, zone.depth / 2]));
    }
    const openDecisions = state.decisions.filter(item => item.status === 'open').length;
    dynamicGroup.add(label(resources, 'FOUNDER HUB', openDecisions ? `${openDecisions} direction ${openDecisions === 1 ? 'question' : 'questions'}` : 'Shared direction', '#556b60', 3.1, [0, 2.8, 1]));
    dynamicGroup.add(label(resources, state.mode === 'demo' ? 'SAMPLE OFFICE' : 'LIVE WORKSPACE', state.mode === 'demo' ? 'Illustrative replay · no agents running' : 'Recorded tasks · not simulated conversations', '#627c72', 4.2, [0, .45, 11.1]));
    const taskById = new Map(state.tasks.map(task => [task.id, task]));
    let arcs = 0;
    for (const task of state.tasks) {
      if (task.status === 'dismissed') continue;
      const end = taskPositions.get(task.id) ?? (task.agentId ? agentPositions.get(task.agentId) : undefined);
      if (!end) continue;
      for (const dependencyId of task.dependsOn) {
        if (arcs >= 30) break;
        const previous = taskById.get(dependencyId), start = taskPositions.get(dependencyId) ?? (previous?.agentId ? agentPositions.get(previous.agentId) : undefined);
        if (!previous || !start || start.distanceTo(end) < .05) continue;
        const middle = start.clone().lerp(end, .5); middle.y = Math.min(5, 1.7 + start.distanceTo(end) * .17);
        const curve = new THREE.CatmullRomCurve3([start, start.clone().lerp(middle, .52), middle, middle.clone().lerp(end, .48), end]);
        const dependencyReady = previous.status === 'done' || (task.handoff === 'delivery' && previous.status === 'review');
        const blocked = !dependencyReady || previous.requiresDirection;
        const color = previous.status === 'failed' ? '#ce8176' : previous.status === 'paused' ? '#939fa4' : blocked || task.requiresDirection ? '#c6a46b' : task.status === 'running' ? '#6faaa4' : '#a8b6ae';
        const tube = new THREE.Mesh(resources.geometry(new THREE.TubeGeometry(curve, 36, blocked ? .032 : .022, 5, false)), resources.material(color, { transparent: true, opacity: blocked ? .78 : .57 })); tube.userData.selection = { kind: 'task', id: task.id } satisfies OfficeSelection; tube.userData.title = `Dependency: ${previous.title} → ${task.title}${blocked ? ` · blocked: ${previous.requiresDirection ? 'needs direction' : previous.status}` : ''}`; dynamicGroup.add(tube);
        const arrow = new THREE.Mesh(resources.geometry(new THREE.ConeGeometry(.09, .22, 8)), resources.material(color)); arrow.position.copy(curve.getPointAt(.88)); arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), curve.getTangentAt(.88).normalize()); dynamicGroup.add(arrow);
        if (task.status === 'running' && !blocked) { const bead = sphere(resources, dynamicGroup, .075, [start.x, start.y, start.z], '#83b4a9'); animatedFlows.push({ mesh: bead, curve, offset: arcs * .19 }); }
        arcs++;
      }
    }
    canvas.dataset.agentCount = String(agentCount); canvas.dataset.taskCount = String(taskCount); canvas.dataset.dependencyCount = String(arcs); canvas.dataset.totalAgentCount = String(state.agents.length); canvas.dataset.totalTaskCount = String(state.tasks.length);
    if (focusedSelection) { const position = focusPositions.get(`${focusedSelection.kind}:${focusedSelection.id}`); selectionRing.visible = !!position; if (position) selectionRing.position.set(position.x, .18, position.z); }
    resize(); syncFrame();
  };
  resize(); syncFrame();
  return {
    update,
    focus: selection => {
      if (disposed) return;
      const position = focusPositions.get(`${selection.kind}:${selection.id}`);
      if (!position) return;
      focusedSelection = selection; selectionRing.visible = true; selectionRing.position.set(position.x, .18, position.z); selectionRing.scale.setScalar(selection.kind === 'department' ? 3 : selection.kind === 'agent' ? 1.25 : .75);
      controls.enableDamping = false; controls.update();
      const target = position.clone(), offset = camera.position.clone().sub(controls.target);
      cameraTransition = { fromTarget: controls.target.clone(), toTarget: target, fromPosition: camera.position.clone(), toPosition: target.clone().add(offset), fromZoom: camera.zoom, toZoom: selection.kind === 'department' ? 1.85 : selection.kind === 'agent' ? 2.45 : 2.65, startedAt: performance.now() };
      canvas.dataset.focusKind = selection.kind; canvas.dataset.focusId = selection.id; syncFrame();
    },
    resetView: () => { if (!disposed) { focusedSelection = null; selectionRing.visible = false; delete canvas.dataset.focusKind; delete canvas.dataset.focusId; resetView(); syncFrame(); } },
    setMotion: enabled => { motionEnabled = enabled; syncFrame(); },
    dispose: () => {
      if (disposed) return; disposed = true; if (frame) cancelAnimationFrame(frame); frame = 0;
      observer.disconnect(); document.removeEventListener('visibilitychange', visible); reduced.removeEventListener('change', visible); controls.removeEventListener('change', changed); controls.removeEventListener('start', interruptFocus); controls.dispose();
      canvas.removeEventListener('pointerdown', pointerDown); canvas.removeEventListener('pointerup', pointerUp); canvas.removeEventListener('pointermove', pointerMove); canvas.removeEventListener('pointerleave', pointerLeave); canvas.removeEventListener('webglcontextlost', contextLost); canvas.removeEventListener('webglcontextrestored', contextRestored);
      staticResources.dispose(); dynamicResources.dispose(); sunlight.shadow.dispose(); renderer.dispose(); renderer.forceContextLoss(); canvas.remove(); tooltip.remove(); graphicsNotice.remove(); scene.clear();
    },
  };
}
