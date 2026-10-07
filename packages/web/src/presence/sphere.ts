import type { PresenceState } from "@friend/protocol";
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  PerspectiveCamera,
  Points,
  Scene,
  ShaderMaterial,
  WebGLRenderer,
} from "three";
import { PresenceCore, type PresenceHandle, type PresenceMode } from "./core";
import { fragmentShader, vertexShader } from "./shaders";

/** `count` points spread evenly on the unit sphere (golden-angle spiral). */
export function fibonacciSphere(count: number): Float32Array {
  const out = new Float32Array(count * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (2 * (i + 0.5)) / count;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    out[i * 3] = Math.cos(theta) * r;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = Math.sin(theta) * r;
  }
  return out;
}

export class ParticleSphere implements PresenceHandle {
  private core: PresenceCore;
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(45, 1, 0.1, 50);
  private material: ShaderMaterial;
  private geometry = new BufferGeometry();
  private raf = 0;
  private last = 0;
  private ro: ResizeObserver;
  private disposed = false;

  constructor(private host: HTMLElement, count: number, accent: string, reducedMotion: boolean) {
    this.core = new PresenceCore({ reducedMotion });
    this.renderer = new WebGLRenderer({ alpha: true, antialias: false, powerPreference: "high-performance" });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.domElement.style.cssText = "width:100%;height:100%;display:block";
    host.appendChild(this.renderer.domElement);

    this.geometry.setAttribute("position", new BufferAttribute(fibonacciSphere(count), 3));
    const seeds = new Float32Array(count);
    for (let i = 0; i < count; i++) seeds[i] = Math.random();
    this.geometry.setAttribute("aSeed", new BufferAttribute(seeds, 1));

    this.material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: {
        uPhase: { value: 0 },
        uAngle: { value: 0 },
        uAmp: { value: 0 },
        uNoise: { value: 0.05 },
        uSize: { value: 1.6 },
        uTighten: { value: 0 },
        uPixel: { value: Math.min(window.devicePixelRatio || 1, 2) },
        uBright: { value: 0.55 },
        uColor: { value: new Color(accent) },
      },
    });
    this.scene.add(new Points(this.geometry, this.material));
    this.camera.position.z = 3.4;

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
    this.raf = requestAnimationFrame(this.frame);
  }

  private resize(): void {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // keep the whole sphere visible on tall (phone) screens
    this.camera.position.z = w / h < 1 ? 3.4 / Math.max(0.55, w / h) : 3.4;
  }

  private frame = (t: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    if (document.hidden) {
      this.last = t;
      return;
    }
    const dt = this.last ? Math.min((t - this.last) / 1000, 0.1) : 0.016;
    this.last = t;
    this.core.tick(dt);
    const u = this.core.uniforms();
    const m = this.material.uniforms;
    m.uPhase!.value = u.phase;
    m.uAngle!.value = u.angle;
    m.uAmp!.value = u.amplitude;
    m.uNoise!.value = u.noise;
    m.uSize!.value = u.size;
    m.uTighten!.value = u.tighten;
    m.uBright!.value = u.brightness;
    this.renderer.render(this.scene, this.camera);
  };

  setState(s: PresenceState): void {
    this.core.setState(s);
  }
  setAmplitude(v: number): void {
    this.core.setAmplitude(v);
  }
  setMode(_m: PresenceMode): void {
    this.resize();
  }
  setAccent(color: string): void {
    (this.material.uniforms.uColor!.value as Color).set(color);
  }
  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.geometry.dispose();
    this.material.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
