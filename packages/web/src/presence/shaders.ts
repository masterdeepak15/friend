export const vertexShader = /* glsl */ `
uniform float uPhase;
uniform float uAngle;
uniform float uAmp;
uniform float uNoise;
uniform float uSize;
uniform float uTighten;
uniform float uPixel;
attribute float aSeed;
varying float vGlow;

float hash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash(i + vec3(0,0,0)), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
    mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y),
    f.z);
}

void main() {
  vec3 p = position;
  float n = vnoise(p * 2.2 + vec3(0.0, uPhase, uPhase * 0.7));
  float n2 = vnoise(p * 5.0 - vec3(uPhase * 1.3));
  float disp = (n - 0.5) * uNoise * 2.0 + (n2 - 0.5) * uAmp * 0.55 + uAmp * 0.12 * sin(uPhase * 6.0 + aSeed * 6.2831);
  vec3 pos = p * ((1.0 - uTighten) + disp);
  float c = cos(uAngle);
  float s = sin(uAngle);
  pos = vec3(c * pos.x + s * pos.z, pos.y, -s * pos.x + c * pos.z);
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;
  float sz = uSize * (0.7 + aSeed * 0.6) * (1.0 + uAmp * 0.8);
  gl_PointSize = sz * uPixel * (4.2 / -mv.z);
  vGlow = 0.6 + 0.4 * n + uAmp * 0.5;
}
`;

export const fragmentShader = /* glsl */ `
uniform vec3 uColor;
uniform float uBright;
varying float vGlow;

void main() {
  float d = length(gl_PointCoord - 0.5);
  if (d > 0.5) discard;
  float a = smoothstep(0.5, 0.0, d);
  gl_FragColor = vec4(uColor * vGlow * uBright, a * 0.9 * uBright);
}
`;
