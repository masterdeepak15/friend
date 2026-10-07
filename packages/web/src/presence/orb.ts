import type { PresenceState } from "@friend/protocol";
import {
  AdditiveBlending,
  Color,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  WebGLRenderer,
} from "three";
import { PresenceCore, type PresenceHandle, type PresenceMode } from "./core";

const vertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const fragmentShader = /* glsl */ `
uniform float uPhase;
uniform float uAmp;
uniform float uBright;
uniform float uNoise;
uniform float uTighten;
uniform float uAspect;
uniform vec3 uColor;
varying vec2 vUv;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.0; a *= 0.5; }
  return v;
}

void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  if (uAspect > 1.0) p.x *= uAspect; else p.y /= uAspect;
  float r = length(p);
  float ang = atan(p.y, p.x);
  // use cos/sin of the angle (not the angle itself) so the noise has no seam where atan() wraps
  vec2 q = vec2(cos(ang), sin(ang)) * 1.5;
  float swirl = fbm(q + vec2(uPhase * 0.8, r * 3.0 - uPhase * 0.6) + uNoise * 4.0);
  float R = 0.55 * (1.0 - uTighten) + uAmp * 0.06 * sin(uPhase * 8.0);
  float edge = R + (swirl - 0.5) * (0.06 + uNoise * 0.5);
  float body = smoothstep(edge + 0.02, edge - 0.25, r);
  float rim = exp(-pow((r - edge) * 14.0, 2.0));
  float halo = exp(-max(r - edge, 0.0) * 3.0) * 0.35;
  float plasma = fbm(p * 3.0 + vec2(uPhase * 0.5, -uPhase * 0.4)) * body;
  float ripple = uAmp * exp(-pow(r - edge - 0.1 - 0.12 * sin(uPhase * 6.0), 2.0) * 60.0) * 0.6;
  float v = body * 0.35 + plasma * 0.7 + rim * 1.1 + halo + ripple;
  gl_FragColor = vec4(uColor * v * uBright, clamp(v * uBright, 0.0, 1.0));
}
`;

/** Glowing plasma orb rendered with a single full-screen fragment shader. */
export class OrbPresence implements PresenceHandle {
  private core: PresenceCore;
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private material: ShaderMaterial;
  private geometry = new PlaneGeometry(2, 2);
  private raf = 0;
  private last = 0;
  private ro: ResizeObserver;
  private disposed = false;

  constructor(private host: HTMLElement, accent: string, reducedMotion: boolean) {
    this.core = new PresenceCore({ reducedMotion });
    this.renderer = new WebGLRenderer({ alpha: true, antialias: false });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.domElement.style.cssText = "width:100%;height:100%;display:block";
    host.appendChild(this.renderer.domElement);
    this.material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: {
        uPhase: { value: 0 },
        uAmp: { value: 0 },
        uBright: { value: 0.85 },
        uNoise: { value: 0.05 },
        uTighten: { value: 0 },
        uAspect: { value: 1 },
        uColor: { value: new Color(accent) },
      },
    });
    this.scene.add(new Mesh(this.geometry, this.material));
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
    this.material.uniforms.uAspect!.value = w / h;
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
    m.uAmp!.value = u.amplitude;
    m.uBright!.value = u.brightness;
    m.uNoise!.value = u.noise;
    m.uTighten!.value = u.tighten;
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
  setIntensity(v: number): void {
    this.core.setIntensity(v);
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
