# Friend PC agent helper. One long-lived Windows PowerShell 5.1 process: it compiles the C# below once, then answers JSON lines on stdin
# ({"id":1,"op":"snapshot","args":{}}) with JSON lines on stdout ({"id":1,"ok":true,"result":{...}}), and reports what the person at the
# PC does as events ({"event":"human"}, {"event":"hotkey"}). Needs nothing installed: Windows ships everything it uses.
$ErrorActionPreference = 'Stop'
$src = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Forms;

namespace FriendHelper
{
    public static class Native
    {
        [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
        [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
        [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }
        [StructLayout(LayoutKind.Sequential)] public struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData, flags, time; public IntPtr extra; }
        [StructLayout(LayoutKind.Sequential)] public struct KBDLLHOOKSTRUCT { public uint vkCode, scanCode, flags, time; public IntPtr extra; }
        public delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);
        public delegate bool EnumProc(IntPtr h, IntPtr l);

        [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
        [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
        [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
        [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hh, bool repaint);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
        [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
        [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
        [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
        [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
        [DllImport("user32.dll")] public static extern IntPtr SetWindowsHookEx(int id, HookProc p, IntPtr mod, uint thread);
        [DllImport("user32.dll")] public static extern bool UnhookWindowsHookEx(IntPtr h);
        [DllImport("user32.dll")] public static extern IntPtr CallNextHookEx(IntPtr h, int code, IntPtr w, IntPtr l);
        [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int value, int size);
        [DllImport("kernel32.dll")] public static extern IntPtr GetModuleHandle(string name);
        [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    }

    /// <summary>The arguments of a call, read leniently (the JSON reader gives ints, decimals and doubles).</summary>
    public static class Args
    {
        public static string S(Dictionary<string, object> a, string k, string d)
        {
            object v; return a.TryGetValue(k, out v) && v != null ? Convert.ToString(v) : d;
        }
        public static int I(Dictionary<string, object> a, string k, int d)
        {
            object v; return a.TryGetValue(k, out v) && v != null ? (int)Math.Round(Convert.ToDouble(v)) : d;
        }
        public static double D(Dictionary<string, object> a, string k, double d)
        {
            object v; return a.TryGetValue(k, out v) && v != null ? Convert.ToDouble(v) : d;
        }
        public static bool B(Dictionary<string, object> a, string k, bool d)
        {
            object v; return a.TryGetValue(k, out v) && v != null ? Convert.ToBoolean(v) : d;
        }
        public static bool Has(Dictionary<string, object> a, string k)
        {
            object v; return a.TryGetValue(k, out v) && v != null;
        }
        public static List<object> L(Dictionary<string, object> a, string k)
        {
            object v; if (!a.TryGetValue(k, out v) || v == null) return new List<object>();
            var arr = v as System.Collections.ArrayList; if (arr != null) return new List<object>(arr.ToArray());
            var l = v as List<object>; return l ?? new List<object>();
        }
    }

    /// <summary>The mouse and keyboard, moved the way a hand does it.</summary>
    public static class Input
    {
        static readonly Random Rng = new Random();
        const uint MOVE = 0x0001, LDOWN = 0x0002, LUP = 0x0004, RDOWN = 0x0008, RUP = 0x0010, MDOWN = 0x0020, MUP = 0x0040, WHEEL = 0x0800, HWHEEL = 0x1000, ABS = 0x8000, VDESK = 0x4000;
        const uint KEYUP = 0x0002, UNICODE = 0x0004, EXT = 0x0001;

        public static System.Drawing.Rectangle Virtual()
        {
            return new System.Drawing.Rectangle(Native.GetSystemMetrics(76), Native.GetSystemMetrics(77), Native.GetSystemMetrics(78), Native.GetSystemMetrics(79));
        }

        static void Send(Native.INPUT i)
        {
            if (Native.SendInput(1, new[] { i }, Marshal.SizeOf(typeof(Native.INPUT))) == 0) throw new InvalidOperationException("Windows did not accept the input (a window running as administrator, or the secure desktop, cannot be controlled).");
        }
        static Native.INPUT Mouse(uint flags, int dx, int dy, uint data)
        {
            var i = new Native.INPUT(); i.type = 0; i.U.mi.dx = dx; i.U.mi.dy = dy; i.U.mi.mouseData = data; i.U.mi.dwFlags = flags; return i;
        }
        static Native.INPUT Key(ushort vk, ushort scan, uint flags)
        {
            var i = new Native.INPUT(); i.type = 1; i.U.ki.wVk = vk; i.U.ki.wScan = scan; i.U.ki.dwFlags = flags; return i;
        }

        public static void MoveAbs(int x, int y)
        {
            var v = Virtual();
            int nx = (int)Math.Round((x - v.Left) * 65535.0 / Math.Max(1, v.Width - 1));
            int ny = (int)Math.Round((y - v.Top) * 65535.0 / Math.Max(1, v.Height - 1));
            Send(Mouse(MOVE | ABS | VDESK, nx, ny, 0));
        }

        /// <summary>Moves the pointer along a slightly curved, eased path of 150 to 450 ms.</summary>
        public static void MoveSmooth(int x, int y)
        {
            Native.POINT p; Native.GetCursorPos(out p);
            double dx = x - p.X, dy = y - p.Y, dist = Math.Sqrt(dx * dx + dy * dy);
            if (dist < 2) { MoveAbs(x, y); return; }
            double ms = Math.Max(150, Math.Min(450, 150 + dist * 0.25));
            int steps = Math.Max(6, (int)(ms / 8));
            double nx = -dy / dist, ny = dx / dist, bend = (Rng.NextDouble() - 0.5) * Math.Min(60, dist * 0.15);
            double cx = p.X + dx / 2 + nx * bend, cy = p.Y + dy / 2 + ny * bend;
            for (int s = 1; s <= steps; s++)
            {
                double t = (double)s / steps, e = t < 0.5 ? 4 * t * t * t : 1 - Math.Pow(-2 * t + 2, 3) / 2, u = 1 - e;
                MoveAbs((int)Math.Round(u * u * p.X + 2 * u * e * cx + e * e * x), (int)Math.Round(u * u * p.Y + 2 * u * e * cy + e * e * y));
                Thread.Sleep((int)(ms / steps));
            }
            MoveAbs(x, y);
        }

        public static void Button(string button, bool down)
        {
            uint f = button == "right" ? (down ? RDOWN : RUP) : button == "middle" ? (down ? MDOWN : MUP) : (down ? LDOWN : LUP);
            Send(Mouse(f, 0, 0, 0));
        }

        public static void Click(string button, int clicks)
        {
            for (int i = 0; i < clicks; i++) { Button(button, true); Thread.Sleep(35 + Rng.Next(30)); Button(button, false); if (i < clicks - 1) Thread.Sleep(70); }
        }

        public static void Wheel(bool horizontal, int amount)
        {
            Send(Mouse(horizontal ? HWHEEL : WHEEL, 0, 0, unchecked((uint)amount)));
        }

        public static void TypeText(string text)
        {
            foreach (char c in text)
            {
                if (c == '\r') continue;
                if (c == '\n') { Press(0x0D); Thread.Sleep(30); continue; }
                if (c == '\t') { Press(0x09); Thread.Sleep(30); continue; }
                Send(Key(0, c, UNICODE)); Send(Key(0, c, UNICODE | KEYUP));
                Thread.Sleep(10 + Rng.Next(28) + (c == ' ' || c == '.' || c == ',' ? Rng.Next(35) : 0));
            }
        }

        public static void Press(ushort vk)
        {
            Send(Key(vk, 0, IsExtended(vk) ? EXT : 0)); Send(Key(vk, 0, KEYUP | (IsExtended(vk) ? EXT : 0)));
        }
        static bool IsExtended(ushort vk)
        {
            return vk == 0x26 || vk == 0x28 || vk == 0x25 || vk == 0x27 || vk == 0x21 || vk == 0x22 || vk == 0x23 || vk == 0x24 || vk == 0x2D || vk == 0x2E || vk == 0x6F;
        }

        static readonly Dictionary<string, ushort> Names = new Dictionary<string, ushort>
        {
            {"ctrl",0x11},{"control",0x11},{"alt",0x12},{"shift",0x10},{"win",0x5B},{"windows",0x5B},{"meta",0x5B},{"enter",0x0D},{"return",0x0D},{"tab",0x09},{"esc",0x1B},{"escape",0x1B},
            {"space",0x20},{"backspace",0x08},{"delete",0x2E},{"del",0x2E},{"insert",0x2D},{"home",0x24},{"end",0x23},{"pageup",0x21},{"pagedown",0x22},{"up",0x26},{"down",0x28},{"left",0x25},{"right",0x27},
            {"printscreen",0x2C},{"capslock",0x14},{"menu",0x5D},{"apps",0x5D},{"plus",0xBB},{"minus",0xBD},{"comma",0xBC},{"period",0xBE}
        };
        public static ushort Vk(string name)
        {
            string n = name.Trim().ToLowerInvariant();
            ushort v; if (Names.TryGetValue(n, out v)) return v;
            if (n.Length == 1) { char c = n[0]; if (c >= 'a' && c <= 'z') return (ushort)(0x41 + (c - 'a')); if (c >= '0' && c <= '9') return (ushort)(0x30 + (c - '0')); }
            if (n.Length >= 2 && n[0] == 'f') { int f; if (int.TryParse(n.Substring(1), out f) && f >= 1 && f <= 24) return (ushort)(0x70 + f - 1); }
            throw new ArgumentException("Unknown key: " + name);
        }

        /// <summary>Presses a combination such as ctrl+shift+esc: modifiers down, the key, modifiers up.</summary>
        public static void Shortcut(string combo)
        {
            var keys = new List<ushort>();
            foreach (string part in combo.Split('+')) if (part.Trim().Length > 0) keys.Add(Vk(part));
            if (keys.Count == 0) throw new ArgumentException("Give a key combination such as ctrl+c.");
            for (int i = 0; i < keys.Count; i++) { Send(Key(keys[i], 0, IsExtended(keys[i]) ? EXT : 0)); Thread.Sleep(15); }
            Thread.Sleep(40);
            for (int i = keys.Count - 1; i >= 0; i--) { Send(Key(keys[i], 0, KEYUP | (IsExtended(keys[i]) ? EXT : 0))); Thread.Sleep(10); }
        }
    }

    /// <summary>Watches for the real person using the mouse or keyboard (our own input is marked as injected and ignored), and for the stop hotkey.</summary>
    public static class Hooks
    {
        static Native.HookProc mouseProc, keyProc;
        static long lastHuman;
        public static long LastHuman { get { return Interlocked.Read(ref lastHuman); } }

        static void Human()
        {
            long now = Environment.TickCount;
            if (now - Interlocked.Read(ref lastHuman) < 250 && lastHuman != 0) return;
            Interlocked.Exchange(ref lastHuman, now == 0 ? 1 : now);
            Host.Out("{\"event\":\"human\"}");
        }
        static IntPtr OnMouse(int code, IntPtr w, IntPtr l)
        {
            if (code >= 0) { var s = (Native.MSLLHOOKSTRUCT)Marshal.PtrToStructure(l, typeof(Native.MSLLHOOKSTRUCT)); if ((s.flags & 1) == 0) Human(); }
            return Native.CallNextHookEx(IntPtr.Zero, code, w, l);
        }
        static IntPtr OnKey(int code, IntPtr w, IntPtr l)
        {
            if (code >= 0)
            {
                var s = (Native.KBDLLHOOKSTRUCT)Marshal.PtrToStructure(l, typeof(Native.KBDLLHOOKSTRUCT));
                if ((s.flags & 0x10) == 0)
                {
                    bool down = (int)w == 0x100 || (int)w == 0x104;
                    if (down && s.vkCode == 0x1B && (Native.GetAsyncKeyState(0x11) & 0x8000) != 0 && (Native.GetAsyncKeyState(0x12) & 0x8000) != 0 && (Native.GetAsyncKeyState(0x10) & 0x8000) != 0) Host.Out("{\"event\":\"hotkey\"}");
                    else Human();
                }
            }
            return Native.CallNextHookEx(IntPtr.Zero, code, w, l);
        }
        public static void Start()
        {
            var t = new Thread(delegate ()
            {
                mouseProc = OnMouse; keyProc = OnKey;
                IntPtr mod = Native.GetModuleHandle(null);
                Native.SetWindowsHookEx(14, mouseProc, mod, 0);
                Native.SetWindowsHookEx(13, keyProc, mod, 0);
                Application.Run();
            });
            t.IsBackground = true; t.SetApartmentState(ApartmentState.STA); t.Start();
        }
    }

    /// <summary>A border around the screen and a banner, drawn over everything, that mouse clicks pass through.</summary>
    public class OverlayForm : Form
    {
        public string Banner = "";
        public Color Tint = Color.FromArgb(255, 140, 0);
        public OverlayForm()
        {
            FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; TopMost = true; StartPosition = FormStartPosition.Manual;
            BackColor = Color.Lime; TransparencyKey = Color.Lime; DoubleBuffered = true;
            Bounds = Input.Virtual();
        }
        protected override bool ShowWithoutActivation { get { return true; } }
        protected override CreateParams CreateParams
        {
            get { var cp = base.CreateParams; cp.ExStyle |= 0x80000 | 0x20 | 0x80 | 0x08000000; return cp; } // layered, click-through, tool window, never takes focus
        }
        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics; g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            using (var pen = new Pen(Tint, 8)) g.DrawRectangle(pen, 4, 4, Width - 9, Height - 9);
            if (Banner.Length > 0)
            {
                using (var f = new Font("Segoe UI", 12, FontStyle.Bold))
                {
                    var sz = g.MeasureString(Banner, f); float w = sz.Width + 28, x = (Width - w) / 2;
                    using (var b = new SolidBrush(Tint)) g.FillRectangle(b, x, 8, w, sz.Height + 8);
                    g.DrawString(Banner, f, Brushes.Black, x + 14, 12);
                }
            }
        }
    }

    public static class Overlay
    {
        static OverlayForm form; static Thread thread;
        static readonly ManualResetEvent ready = new ManualResetEvent(false);
        static void Ensure()
        {
            if (thread != null) { ready.WaitOne(5000); return; }
            thread = new Thread(delegate () { form = new OverlayForm(); form.Show(); ready.Set(); Application.Run(form); });
            thread.IsBackground = true; thread.SetApartmentState(ApartmentState.STA); thread.Start(); ready.WaitOne(5000);
        }
        public static void Set(bool show, string text, string color)
        {
            Ensure();
            if (form == null) return;
            form.BeginInvoke(new Action(delegate ()
            {
                form.Banner = text ?? ""; if (!string.IsNullOrEmpty(color)) form.Tint = ColorTranslator.FromHtml(color);
                form.Bounds = Input.Virtual();
                if (show) { form.Visible = true; form.TopMost = true; form.Invalidate(); } else form.Visible = false;
            }));
        }
    }

    /// <summary>The windows and the UI Automation tree: what is on the screen and how to point at it.</summary>
    public static class Ui
    {
        public class Item { public int Label; public string Type = "", Name = "", Id = ""; public int X, Y, W, H; public bool Enabled = true, Scroll; }
        public class Win { public IntPtr Handle; public string Title; public uint Pid; public string Process; public bool Active; public Native.RECT R; }
        static readonly Dictionary<int, AutomationElement> labels = new Dictionary<int, AutomationElement>();
        static readonly HashSet<int> interactive = new HashSet<int>
        {
            ControlType.Button.Id, ControlType.CheckBox.Id, ControlType.ComboBox.Id, ControlType.Edit.Id, ControlType.Hyperlink.Id, ControlType.ListItem.Id, ControlType.MenuItem.Id,
            ControlType.RadioButton.Id, ControlType.Slider.Id, ControlType.Spinner.Id, ControlType.SplitButton.Id, ControlType.TabItem.Id, ControlType.TreeItem.Id, ControlType.DataItem.Id,
            ControlType.Document.Id, ControlType.Menu.Id
        };

        public static string Title(IntPtr h)
        {
            int n = Native.GetWindowTextLength(h); if (n <= 0) return "";
            var sb = new StringBuilder(n + 1); Native.GetWindowText(h, sb, sb.Capacity); return sb.ToString();
        }

        public static List<Win> Windows()
        {
            var list = new List<Win>(); IntPtr fg = Native.GetForegroundWindow();
            Native.EnumWindows(delegate (IntPtr h, IntPtr l)
            {
                if (!Native.IsWindowVisible(h)) return true;
                int cloaked; if (Native.DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true; // hidden app windows that Windows still lists
                if ((Native.GetWindowLong(h, -20) & 0x80) != 0 && h != fg) return true; // tool windows
                string t = Title(h); if (t.Length == 0) return true;
                Native.RECT r; Native.GetWindowRect(h, out r); if (r.Right - r.Left <= 1 || r.Bottom - r.Top <= 1) return true;
                uint pid; Native.GetWindowThreadProcessId(h, out pid);
                string pn = ""; try { pn = Process.GetProcessById((int)pid).ProcessName; } catch (Exception) { }
                list.Add(new Win { Handle = h, Title = t, Pid = pid, Process = pn, Active = h == fg, R = r });
                return true;
            }, IntPtr.Zero);
            return list;
        }

        public static Win Find(string name)
        {
            string q = (name ?? "").ToLowerInvariant();
            foreach (var w in Windows()) if (w.Title.ToLowerInvariant().Contains(q) || (w.Process ?? "").ToLowerInvariant() == q) return w;
            return null;
        }

        public static AutomationElement ByLabel(int n)
        {
            AutomationElement e;
            if (!labels.TryGetValue(n, out e)) throw new InvalidOperationException("There is no element " + n + " on the last snapshot. Take a new pc.snapshot: the numbers change when the screen does.");
            return e;
        }

        public static System.Drawing.Point Center(AutomationElement e)
        {
            System.Windows.Rect r;
            try { r = e.Current.BoundingRectangle; } catch (ElementNotAvailableException) { throw new InvalidOperationException("That element is gone from the screen. Take a new pc.snapshot."); }
            if (r.IsEmpty || double.IsInfinity(r.X)) throw new InvalidOperationException("That element has no place on the screen (hidden or scrolled out). Scroll it into view, or take a new pc.snapshot.");
            return new System.Drawing.Point((int)(r.X + r.Width / 2), (int)(r.Y + r.Height / 2));
        }

        public static System.Drawing.Point Target(Dictionary<string, object> a)
        {
            if (Args.Has(a, "label")) return Center(ByLabel(Args.I(a, "label", 0)));
            if (Args.Has(a, "x") && Args.Has(a, "y")) return new System.Drawing.Point(Args.I(a, "x", 0), Args.I(a, "y", 0));
            throw new ArgumentException("Give an element number (label) or x and y.");
        }

        public static List<Item> Walk(IntPtr hwnd, List<string> texts, int maxNodes, int budgetMs)
        {
            var items = new List<Item>(); var sw = Stopwatch.StartNew(); labels.Clear(); int next = 1, seen = 0;
            var cr = new CacheRequest();
            cr.Add(AutomationElement.NameProperty); cr.Add(AutomationElement.ControlTypeProperty); cr.Add(AutomationElement.BoundingRectangleProperty); cr.Add(AutomationElement.IsOffscreenProperty);
            cr.Add(AutomationElement.IsEnabledProperty); cr.Add(AutomationElement.AutomationIdProperty); cr.Add(AutomationElement.IsScrollPatternAvailableProperty);
            cr.TreeFilter = Automation.ControlViewCondition; cr.TreeScope = TreeScope.Element;
            var walker = TreeWalker.ControlViewWalker; var stack = new Stack<AutomationElement>();
            using (cr.Activate())
            {
                var top = walker.Normalize(AutomationElement.FromHandle(hwnd), cr); stack.Push(top);
                while (stack.Count > 0 && seen < maxNodes && sw.ElapsedMilliseconds < budgetMs)
                {
                    var e = stack.Pop(); seen++;
                    try
                    {
                        var c = e.Cached; var r = c.BoundingRectangle; bool off = c.IsOffscreen;
                        if (!off && !r.IsEmpty && r.Width > 1 && r.Height > 1 && !double.IsInfinity(r.X))
                        {
                            int tid = c.ControlType.Id; string name = c.Name ?? "";
                            bool scroll = false; try { scroll = (bool)e.GetCachedPropertyValue(AutomationElement.IsScrollPatternAvailableProperty); } catch (Exception) { }
                            if (interactive.Contains(tid) || scroll)
                            {
                                var it = new Item { Label = next++, Type = c.ControlType.ProgrammaticName.Replace("ControlType.", ""), Name = name.Length > 120 ? name.Substring(0, 120) : name, Id = c.AutomationId ?? "", X = (int)(r.X + r.Width / 2), Y = (int)(r.Y + r.Height / 2), W = (int)r.Width, H = (int)r.Height, Enabled = c.IsEnabled, Scroll = scroll };
                                items.Add(it); labels[it.Label] = e;
                            }
                            else if (tid == ControlType.Text.Id && name.Length > 0 && texts.Count < 80) texts.Add(name.Length > 140 ? name.Substring(0, 140) : name);
                        }
                    }
                    catch (ElementNotAvailableException) { }
                    var kids = new List<AutomationElement>();
                    try { for (var k = walker.GetFirstChild(e, cr); k != null; k = walker.GetNextSibling(k, cr)) { kids.Add(k); if (kids.Count > 400) break; } } catch (Exception) { }
                    for (int i = kids.Count - 1; i >= 0; i--) stack.Push(kids[i]);
                }
            }
            return items;
        }

        public static string Dump(List<Win> wins, List<Item> items, List<string> texts, System.Drawing.Rectangle area, double scale)
        {
            var sb = new StringBuilder();
            Win active = null; foreach (var w in wins) if (w.Active) active = w;
            sb.Append("Active window: ").Append(active == null ? "(none)" : active.Title + " [" + active.Process + "]").Append('\n');
            sb.Append("Open windows: ");
            for (int i = 0; i < wins.Count && i < 25; i++) sb.Append(i + 1).Append(". ").Append(wins[i].Title.Length > 60 ? wins[i].Title.Substring(0, 60) : wins[i].Title).Append(wins[i].Active ? " (active)" : "").Append(i < wins.Count - 1 && i < 24 ? "; " : "");
            sb.Append('\n');
            sb.Append("Screen area: ").Append(area.Width).Append('x').Append(area.Height).Append(" at ").Append(area.Left).Append(',').Append(area.Top);
            if (scale < 0.999) sb.Append(". The picture is scaled to ").Append(Math.Round(scale * 100)).Append("%: use element numbers, or multiply picture positions by ").Append(Math.Round(1 / scale, 2));
            sb.Append("\nInteractive elements (number | type | name | centre x,y | size):\n");
            foreach (var it in items) sb.Append(it.Label).Append(" | ").Append(it.Type).Append(" | ").Append(it.Name.Replace('\n', ' ')).Append(it.Enabled ? "" : " (disabled)").Append(it.Scroll ? " (scrollable)" : "").Append(" | ").Append(it.X).Append(',').Append(it.Y).Append(" | ").Append(it.W).Append('x').Append(it.H).Append('\n');
            if (items.Count == 0) sb.Append("(none found: the window may draw its own controls; use the picture and x,y positions, or keyboard shortcuts)\n");
            if (texts.Count > 0) { sb.Append("Visible text:\n"); foreach (var t in texts) sb.Append("- ").Append(t.Replace('\n', ' ')).Append('\n'); }
            return sb.Length > 100000 ? sb.ToString(0, 100000) + "\n[cut]" : sb.ToString();
        }

        public static bool Exists(string kind, string text, string window)
        {
            string q = (text ?? "").ToLowerInvariant();
            if (kind == "window_active") { var fg = Native.GetForegroundWindow(); return Title(fg).ToLowerInvariant().Contains((window ?? text ?? "").ToLowerInvariant()); }
            if (kind == "focused") { try { var f = AutomationElement.FocusedElement; return (f.Current.Name ?? "").ToLowerInvariant().Contains(q); } catch (Exception) { return false; } }
            var texts = new List<string>(); var items = Walk(Native.GetForegroundWindow(), texts, 1500, 1500);
            if (kind == "text_exists") { foreach (var t in texts) if (t.ToLowerInvariant().Contains(q)) return true; foreach (var it in items) if (it.Name.ToLowerInvariant().Contains(q)) return true; return false; }
            foreach (var it in items) if (it.Name.ToLowerInvariant().Contains(q)) { if (kind == "element_enabled") { if (it.Enabled) return true; } else return true; }
            return false;
        }
    }

    public static class Shot
    {
        public static System.Drawing.Rectangle Area(Dictionary<string, object> a)
        {
            var reg = Args.L(a, "region");
            if (reg.Count == 4) { int l = Convert.ToInt32(reg[0]), t = Convert.ToInt32(reg[1]), r = Convert.ToInt32(reg[2]), b = Convert.ToInt32(reg[3]); return new System.Drawing.Rectangle(l, t, Math.Max(1, r - l), Math.Max(1, b - t)); }
            if (Args.Has(a, "display")) { var all = Screen.AllScreens; int d = Args.I(a, "display", 0); if (d < 0 || d >= all.Length) throw new ArgumentException("There is no display " + d + " (there are " + all.Length + ")."); return all[d].Bounds; }
            return Input.Virtual();
        }

        public static Dictionary<string, object> Capture(System.Drawing.Rectangle area, List<Ui.Item> marks)
        {
            using (var bmp = new Bitmap(area.Width, area.Height, PixelFormat.Format32bppArgb))
            {
                using (var g = Graphics.FromImage(bmp))
                {
                    g.CopyFromScreen(area.Left, area.Top, 0, 0, area.Size, CopyPixelOperation.SourceCopy);
                    if (marks != null)
                    {
                        using (var font = new Font("Segoe UI", 9, FontStyle.Bold))
                        using (var pen = new Pen(Color.FromArgb(255, 220, 0, 90), 2))
                        using (var back = new SolidBrush(Color.FromArgb(255, 220, 0, 90)))
                            foreach (var it in marks)
                            {
                                int x = it.X - it.W / 2 - area.Left, y = it.Y - it.H / 2 - area.Top;
                                g.DrawRectangle(pen, x, y, it.W, it.H);
                                string s = it.Label.ToString(); var sz = g.MeasureString(s, font);
                                g.FillRectangle(back, x, y, sz.Width + 2, sz.Height); g.DrawString(s, font, Brushes.White, x, y);
                            }
                    }
                }
                double scale = Math.Min(1.0, Math.Min(1920.0 / bmp.Width, 1080.0 / bmp.Height)); Bitmap outBmp = bmp; bool own = false;
                if (scale < 1.0) { outBmp = new Bitmap((int)(bmp.Width * scale), (int)(bmp.Height * scale)); own = true; using (var g2 = Graphics.FromImage(outBmp)) { g2.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic; g2.DrawImage(bmp, 0, 0, outBmp.Width, outBmp.Height); } }
                try
                {
                    using (var ms = new MemoryStream()) { outBmp.Save(ms, ImageFormat.Png); return new Dictionary<string, object> { { "mime", "image/png" }, { "data", Convert.ToBase64String(ms.ToArray()) }, { "scale", scale } }; }
                }
                finally { if (own) outBmp.Dispose(); }
            }
        }
    }

    public static class Host
    {
        static readonly object outLock = new object();
        static readonly JavaScriptSerializer J = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        public static void Out(string s) { lock (outLock) { Console.Out.WriteLine(s); Console.Out.Flush(); } }

        static string Fail(int id, string message)
        {
            return J.Serialize(new Dictionary<string, object> { { "id", id }, { "ok", false }, { "error", message } });
        }

        public static void Run()
        {
            Console.OutputEncoding = new UTF8Encoding(false); Console.InputEncoding = new UTF8Encoding(false);
            Native.SetProcessDPIAware();
            Hooks.Start();
            Out("{\"event\":\"ready\"}");
            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                if (line.Trim().Length == 0) continue;
                int id = 0;
                try
                {
                    var req = (Dictionary<string, object>)J.DeserializeObject(line);
                    id = Convert.ToInt32(req["id"]); string op = Convert.ToString(req["op"]);
                    object av; Dictionary<string, object> args = req.TryGetValue("args", out av) ? av as Dictionary<string, object> : null; if (args == null) args = new Dictionary<string, object>();
                    object result = Ops.Dispatch(op, args);
                    Out(J.Serialize(new Dictionary<string, object> { { "id", id }, { "ok", true }, { "result", result } }));
                }
                catch (Exception e) { Out(Fail(id, e.Message)); }
            }
        }
    }

    public static class Ops
    {
        static Dictionary<string, object> Text(string text) { return new Dictionary<string, object> { { "text", text } }; }

        public static object Dispatch(string op, Dictionary<string, object> a)
        {
            switch (op)
            {
                case "ping": return Text("pong");
                case "displays": return Displays();
                case "snapshot": return Snapshot(a);
                case "screenshot": return Screenshot(a);
                case "click": return Click(a);
                case "type": return Type(a);
                case "scroll": return Scroll(a);
                case "move": return Move(a);
                case "shortcut": Input.Shortcut(Args.S(a, "keys", "")); return Text("Pressed " + Args.S(a, "keys", ""));
                case "multi_select": return MultiSelect(a);
                case "multi_edit": return MultiEdit(a);
                case "app": return App(a);
                case "clipboard": return Clip(a);
                case "wait_for": return WaitFor(a);
                case "overlay": Overlay.Set(Args.B(a, "show", true), Args.S(a, "text", ""), Args.S(a, "color", "")); return Text("ok");
                case "seal": return Text(Convert.ToBase64String(ProtectedData.Protect(Encoding.UTF8.GetBytes(Args.S(a, "text", "")), Encoding.UTF8.GetBytes("friend-pc-agent"), DataProtectionScope.CurrentUser)));
                case "unseal": return Text(Encoding.UTF8.GetString(ProtectedData.Unprotect(Convert.FromBase64String(Args.S(a, "text", "")), Encoding.UTF8.GetBytes("friend-pc-agent"), DataProtectionScope.CurrentUser)));
                case "window": return WindowInfo();
                case "element": return ElementInfo(a);
                default:
                    object r; if (Terminals.TryDispatch(op, a, out r)) return r;
                    throw new ArgumentException("Unknown operation: " + op);
            }
        }

        static object Displays()
        {
            var sb = new StringBuilder(); int i = 0;
            foreach (var s in Screen.AllScreens) { sb.Append(i++).Append(": ").Append(s.Bounds.Width).Append('x').Append(s.Bounds.Height).Append(" at ").Append(s.Bounds.Left).Append(',').Append(s.Bounds.Top).Append(s.Primary ? " (primary)" : "").Append(", work area ").Append(s.WorkingArea.Width).Append('x').Append(s.WorkingArea.Height).Append('\n'); }
            using (var g = Graphics.FromHwnd(IntPtr.Zero)) sb.Append("Scale: ").Append(Math.Round(g.DpiX / 96.0 * 100)).Append("%\n");
            return Text(sb.ToString());
        }

        static object WindowInfo()
        {
            var fg = Native.GetForegroundWindow(); return Text(Ui.Title(fg));
        }

        static object ElementInfo(Dictionary<string, object> a)
        {
            var e = Ui.ByLabel(Args.I(a, "label", 0));
            return Text(e.Current.ControlType.ProgrammaticName.Replace("ControlType.", "") + "|" + e.Current.Name);
        }

        static object Snapshot(Dictionary<string, object> a)
        {
            var wins = Ui.Windows(); var texts = new List<string>();
            var fg = Native.GetForegroundWindow();
            var items = fg == IntPtr.Zero ? new List<Ui.Item>() : Ui.Walk(fg, texts, 2500, 4000);
            var area = Shot.Area(a);
            var inArea = new List<Ui.Item>(); foreach (var it in items) if (area.Contains(it.X, it.Y)) inArea.Add(it);
            var res = new Dictionary<string, object>();
            double scale = Math.Min(1.0, Math.Min(1920.0 / area.Width, 1080.0 / area.Height));
            if (Args.B(a, "vision", true)) { var img = Shot.Capture(area, Args.B(a, "annotate", true) ? inArea : null); scale = Convert.ToDouble(img["scale"]); res["image"] = img; }
            res["text"] = Ui.Dump(wins, inArea, texts, area, scale);
            return res;
        }

        static object Screenshot(Dictionary<string, object> a)
        {
            var area = Shot.Area(a); var marks = new List<Ui.Item>();
            if (Args.B(a, "annotate", false)) { var texts = new List<string>(); var fg = Native.GetForegroundWindow(); if (fg != IntPtr.Zero) marks = Ui.Walk(fg, texts, 2500, 4000); }
            var img = Shot.Capture(area, marks);
            return new Dictionary<string, object> { { "text", "Screenshot " + area.Width + "x" + area.Height + " at " + area.Left + "," + area.Top + (Convert.ToDouble(img["scale"]) < 0.999 ? ", scaled to " + Math.Round(Convert.ToDouble(img["scale"]) * 100) + "%" : "") }, { "image", img } };
        }

        static object Click(Dictionary<string, object> a)
        {
            var p = Ui.Target(a); Input.MoveSmooth(p.X, p.Y);
            int clicks = Args.I(a, "clicks", 1); string button = Args.S(a, "button", "left");
            if (clicks == 0) return Text("Pointer moved to " + p.X + "," + p.Y + " (hover).");
            Input.Click(button, clicks); Thread.Sleep(120);
            return Text((clicks == 2 ? "Double clicked" : button == "right" ? "Right clicked" : "Clicked") + " at " + p.X + "," + p.Y + ". Active window now: " + Ui.Title(Native.GetForegroundWindow()));
        }

        static string ReadValue(AutomationElement e)
        {
            try { object pat; if (e.TryGetCurrentPattern(ValuePattern.Pattern, out pat)) return ((ValuePattern)pat).Current.Value; } catch (Exception) { }
            try { object pat; if (e.TryGetCurrentPattern(TextPattern.Pattern, out pat)) return ((TextPattern)pat).DocumentRange.GetText(100000); } catch (Exception) { }
            return null;
        }

        static object Type(Dictionary<string, object> a)
        {
            string text = Args.S(a, "text", ""); AutomationElement el = null;
            if (Args.Has(a, "label") || (Args.Has(a, "x") && Args.Has(a, "y")))
            {
                if (Args.Has(a, "label")) el = Ui.ByLabel(Args.I(a, "label", 0));
                var p = Ui.Target(a); Input.MoveSmooth(p.X, p.Y); Input.Click("left", 1); Thread.Sleep(120);
            }
            else { try { el = AutomationElement.FocusedElement; } catch (Exception) { } }
            if (Args.B(a, "clear", false))
            {
                bool cleared = false;
                if (el != null) { try { object pat; if (el.TryGetCurrentPattern(ValuePattern.Pattern, out pat) && !((ValuePattern)pat).Current.IsReadOnly) { ((ValuePattern)pat).SetValue(""); cleared = true; } } catch (Exception) { } }
                if (!cleared) { Input.Shortcut("ctrl+a"); Thread.Sleep(40); Input.Press(0x08); }
                Thread.Sleep(60);
            }
            string caret = Args.S(a, "caret", "idle");
            if (caret == "start") { Input.Shortcut("ctrl+home"); Thread.Sleep(40); } else if (caret == "end") { Input.Shortcut("ctrl+end"); Thread.Sleep(40); }
            string before = el == null ? null : ReadValue(el);
            Input.TypeText(text); Thread.Sleep(150);
            string note = "";
            if (el != null && text.Length > 0 && text.IndexOf('\n') < 0)
            {
                string after = ReadValue(el);
                if (after != null)
                {
                    string probe = text.Length > 40 ? text.Substring(text.Length - 40) : text;
                    if (after.IndexOf(probe, StringComparison.Ordinal) < 0 && (before == null || after != before + text))
                        throw new InvalidOperationException("The text did not arrive: the field shows \"" + (after.Length > 80 ? after.Substring(0, 80) + "..." : after) + "\". Take a pc.snapshot to see where the keyboard focus is.");
                    note = " Checked: the field shows the text.";
                }
                else note = " (This control cannot be read back, so it was not checked.)";
            }
            if (Args.B(a, "enter", false)) { Thread.Sleep(80); Input.Press(0x0D); }
            return Text("Typed " + text.Length + " characters." + note + (Args.B(a, "enter", false) ? " Pressed Enter." : ""));
        }

        static object Scroll(Dictionary<string, object> a)
        {
            if (Args.Has(a, "label") || Args.Has(a, "x")) { var p = Ui.Target(a); Input.MoveSmooth(p.X, p.Y); }
            string dir = Args.S(a, "direction", "down"); int times = Args.I(a, "times", 3);
            for (int i = 0; i < times; i++) { Input.Wheel(dir == "left" || dir == "right", (dir == "up" || dir == "right" ? 1 : -1) * 120); Thread.Sleep(60); }
            return Text("Scrolled " + dir + " " + times + " times.");
        }

        static object Move(Dictionary<string, object> a)
        {
            var to = Ui.Target(a);
            if (Args.B(a, "drag", false))
            {
                System.Drawing.Point from; if (Args.Has(a, "fromX") && Args.Has(a, "fromY")) from = new System.Drawing.Point(Args.I(a, "fromX", 0), Args.I(a, "fromY", 0)); else { Native.POINT cp; Native.GetCursorPos(out cp); from = new System.Drawing.Point(cp.X, cp.Y); }
                Input.MoveSmooth(from.X, from.Y); Input.Button("left", true); Thread.Sleep(120); Input.MoveSmooth(to.X, to.Y); Thread.Sleep(120); Input.Button("left", false);
                return Text("Dragged from " + from.X + "," + from.Y + " to " + to.X + "," + to.Y + ".");
            }
            Input.MoveSmooth(to.X, to.Y); return Text("Pointer moved to " + to.X + "," + to.Y + ".");
        }

        static object MultiSelect(Dictionary<string, object> a)
        {
            bool ctrl = Args.B(a, "ctrl", true); var pts = new List<System.Drawing.Point>();
            foreach (object l in Args.L(a, "labels")) pts.Add(Ui.Center(Ui.ByLabel(Convert.ToInt32(l))));
            foreach (object p in Args.L(a, "points")) { var xy = p as System.Collections.ArrayList; if (xy != null && xy.Count == 2) pts.Add(new System.Drawing.Point(Convert.ToInt32(xy[0]), Convert.ToInt32(xy[1]))); }
            if (pts.Count == 0) throw new ArgumentException("Give labels or points.");
            if (ctrl) Native.keybd_event(0x11, 0, 0, UIntPtr.Zero);
            try { foreach (var p in pts) { Input.MoveSmooth(p.X, p.Y); Input.Click("left", 1); Thread.Sleep(80); } }
            finally { if (ctrl) Native.keybd_event(0x11, 0, 2, UIntPtr.Zero); }
            return Text("Selected " + pts.Count + " items.");
        }

        static object MultiEdit(Dictionary<string, object> a)
        {
            int n = 0;
            foreach (object o in Args.L(a, "edits")) { var e = o as Dictionary<string, object>; if (e == null) continue; e["clear"] = true; Type(e); n++; }
            return Text("Edited " + n + " fields.");
        }

        static object App(Dictionary<string, object> a)
        {
            string action = Args.S(a, "action", "launch"), name = Args.S(a, "name", ""), path = Args.S(a, "path", "");
            if (action == "launch")
            {
                var before = new HashSet<IntPtr>(); foreach (var w in Ui.Windows()) before.Add(w.Handle);
                string argv = ""; foreach (object o in Args.L(a, "args")) argv += (argv.Length > 0 ? " " : "") + "\"" + Convert.ToString(o).Replace("\"", "\\\"") + "\"";
                string target = path.Length > 0 ? path : name; if (target.Length == 0) throw new ArgumentException("Give the app's name or path.");
                try { Process.Start(new ProcessStartInfo(target, argv) { UseShellExecute = true }); }
                catch (Exception)
                {
                    string id = StartAppId(name);
                    if (id == null) throw new InvalidOperationException("Could not find an app called \"" + name + "\" in the Start menu. Try its full path.");
                    Process.Start(new ProcessStartInfo("explorer.exe", "shell:AppsFolder\\" + id) { UseShellExecute = true });
                }
                for (int i = 0; i < 40; i++) { Thread.Sleep(150); foreach (var w in Ui.Windows()) if (!before.Contains(w.Handle)) { Focus(w); return Text("Launched. New window: " + w.Title); } }
                return Text("Launched " + target + " (no new window appeared yet; take a pc.snapshot).");
            }
            var win = name.Length == 0 && action != "switch" ? Ui.Find(Ui.Title(Native.GetForegroundWindow())) : Ui.Find(name);
            if (win == null) throw new InvalidOperationException("No open window matches \"" + name + "\".");
            if (action == "switch") { Focus(win); return Text("Switched to " + win.Title); }
            if (action == "close") { Native.PostMessage(win.Handle, 0x0010, IntPtr.Zero, IntPtr.Zero); return Text("Asked " + win.Title + " to close."); }
            if (action == "resize" || action == "move")
            {
                Native.ShowWindow(win.Handle, 9);
                int x = Args.I(a, "x", win.R.Left), y = Args.I(a, "y", win.R.Top), w2 = Args.I(a, "w", win.R.Right - win.R.Left), h2 = Args.I(a, "h", win.R.Bottom - win.R.Top);
                Native.MoveWindow(win.Handle, x, y, w2, h2, true); return Text("Window " + win.Title + " is now " + w2 + "x" + h2 + " at " + x + "," + y + ".");
            }
            throw new ArgumentException("Unknown app action: " + action);
        }

        static void Focus(Ui.Win w)
        {
            if (Native.IsIconic(w.Handle)) Native.ShowWindow(w.Handle, 9);
            uint pid; uint cur = Native.GetCurrentThreadId(); uint fgThread = Native.GetWindowThreadProcessId(Native.GetForegroundWindow(), out pid);
            Native.keybd_event(0x12, 0, 0, UIntPtr.Zero); // a bare Alt press lets a background process take the foreground
            Native.AttachThreadInput(cur, fgThread, true); Native.SetForegroundWindow(w.Handle); Native.AttachThreadInput(cur, fgThread, false);
            Native.keybd_event(0x12, 0, 2, UIntPtr.Zero); Thread.Sleep(150);
        }

        static string StartAppId(string name)
        {
            var psi = new ProcessStartInfo("powershell.exe", "-NoProfile -NonInteractive -Command \"Get-StartApps | ForEach-Object { $_.Name + '|' + $_.AppID }\"") { RedirectStandardOutput = true, UseShellExecute = false, CreateNoWindow = true, StandardOutputEncoding = Encoding.UTF8 };
            using (var p = Process.Start(psi))
            {
                string all = p.StandardOutput.ReadToEnd(); p.WaitForExit(15000); string q = name.ToLowerInvariant(), best = null;
                foreach (string l in all.Split('\n')) { int i = l.LastIndexOf('|'); if (i <= 0) continue; string n = l.Substring(0, i).Trim().ToLowerInvariant(); if (n == q) return l.Substring(i + 1).Trim(); if (best == null && n.Contains(q)) best = l.Substring(i + 1).Trim(); }
                return best;
            }
        }

        static object Clip(Dictionary<string, object> a)
        {
            if (Args.S(a, "action", "get") == "set") { Clipboard.SetText(Args.S(a, "text", "")); return Text("Clipboard set (" + Args.S(a, "text", "").Length + " characters)."); }
            return Text(Clipboard.ContainsText() ? Clipboard.GetText() : "(the clipboard has no text)");
        }

        static object WaitFor(Dictionary<string, object> a)
        {
            double timeout = Args.D(a, "timeout", 10); string cond = Args.S(a, "condition", "text_exists"), text = Args.S(a, "text", ""), window = Args.S(a, "window", "");
            var sw = Stopwatch.StartNew();
            while (sw.Elapsed.TotalSeconds < timeout) { if (Ui.Exists(cond, text, window)) return Text("Done: " + cond + " (" + Math.Round(sw.Elapsed.TotalSeconds, 1) + " s)."); Thread.Sleep(250); }
            throw new TimeoutException("Not true after " + timeout + " s: " + cond + " " + (text.Length > 0 ? text : window) + ". Take a pc.snapshot to see what is there.");
        }
    }

    public static class Terminals
    {
        public static bool TryDispatch(string op, Dictionary<string, object> a, out object result) { result = null; return false; }
    }
}
'@
Add-Type -TypeDefinition $src -ReferencedAssemblies @('System.Windows.Forms', 'System.Drawing', 'System.Web.Extensions', 'UIAutomationClient', 'UIAutomationTypes', 'WindowsBase', 'System.Security') -Language CSharp
[FriendHelper.Host]::Run()
