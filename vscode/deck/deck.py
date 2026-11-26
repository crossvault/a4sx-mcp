#!/usr/bin/env python3
"""a4sx deck 0.6 (prototype): the mesh, its cells and your library in one herdr pane (or a VS Code terminal).

Views (keys 1-5): mesh, library, rules, host, move. The selected row's operations are always shown on the right and
run with one key. Short commands run in place; anything a person answers (or that opens the browser) runs in a new
herdr tab. Everything is an ordinary `a4sx` or `herdr` command; the deck stores only the id of its own pane.

Moving a cell between hosts and front ends (view 5): "bring here" starts one of your cells that runs elsewhere on
this host, signed in (the other host's key stops working). Its conversation follows once a4sx #2292 lands (as-is, not
scrubbed); until then there is no "hand off" here (a scrubbed copy would change its peers' names). "Start from a
saved session" starts a cell on this host seeded from a saved conversation. Both are ordinary `a4sx launch` commands
that work from any terminal, so the other side can be VS Code's agent host.

usage: deck.py pane | open | start | label
"""
import base64
import glob
import json
import os
import re
import select
import shlex
import shutil
import socket
import stat
import subprocess
import sys
import threading
import time

try:
    import termios
    import tty
except ImportError:   # Windows: keys come from msvcrt
    termios = tty = None

WIN = os.name == "nt"
HERDR = os.environ.get("HERDR_BIN_PATH") or "herdr"
#: inside a herdr pane the deck uses herdr (tabs, panes, agent states); elsewhere it is a plain terminal program
#: 0.5.0: the deck in the a4sx VS Code extension's "a4sx deck" terminal. A start there is a request to the extension,
#: which checks it again (its check is the one that counts) and opens a VS Code terminal for it. The channel folder and
#: the nonce are in this terminal's environment only; they leave os.environ here, so the deck's own a4sx calls don't
#: inherit them.
_VSC_CHANNEL = os.environ.pop("A4SX_DECK_CHANNEL", "")
_VSC_NONCE = os.environ.pop("A4SX_DECK_NONCE", "")
VSCODE = os.environ.get("A4SX_DECK_HOST") == "vscode" and bool(_VSC_CHANNEL) and bool(_VSC_NONCE)
#: the VS Code window's workspace folders: a start in one of them goes to VS Code, as one in the home folder does
_VSC_FOLDERS = [f for f in os.environ.pop("A4SX_DECK_FOLDERS", "").split(os.pathsep) if f]
#: VS Code started from a herdr pane passes herdr's variables on to its terminals; the extension's deck is not in herdr
IN_HERDR = not VSCODE and bool(os.environ.get("HERDR_SOCKET_PATH") or os.environ.get("HERDR_PANE_ID"))
FRONT = "herdr" if IN_HERDR else ("VS Code" if VSCODE else ("Windows terminal" if WIN else "terminal"))


def _a4sx_argv():
    """How to call a4sx: on Windows the installed a4sx.py with this Python (a .cmd wrapper mangles arguments)."""
    py = os.environ.get("DECK_A4SX_PY") or (os.path.join(os.path.expanduser("~"), ".agent-mdx", "cli", "a4sx.py") if WIN else "")
    if py and os.path.isfile(py):
        return [sys.executable, py]
    return [shutil.which("a4sx") or os.path.expanduser("~/.local/bin/a4sx")]


A4SX_ARGV = _a4sx_argv()
PLUGIN_ID = os.environ.get("HERDR_PLUGIN_ID") or "a4sx.mesh"   # 0.4.0: part of the a4sx.mesh plugin
STATE = os.environ.get("XDG_STATE_HOME") or (os.environ.get("LOCALAPPDATA") if WIN else os.path.expanduser("~/.local/state"))
HOST = socket.gethostname()
VIEWS = ("mesh", "library", "rules", "host", "move")


def rgb(h):
    return f"\033[38;2;{int(h[1:3], 16)};{int(h[3:5], 16)};{int(h[5:7], 16)}m"


def bgc(h):
    return f"\033[48;2;{int(h[1:3], 16)};{int(h[3:5], 16)};{int(h[5:7], 16)}m"


RS, B = "\033[0m", "\033[1m"
FG, DIM, FAINT = rgb("#c0caf5"), rgb("#6b7399"), rgb("#4a5380")
BLUE, CYAN, GREEN, YEL, RED, MAG, ORANGE = (rgb(x) for x in ("#7aa2f7", "#7dcfff", "#9ece6a", "#e0af68", "#f7768e", "#bb9af7", "#ff9e64"))
SELBG, PILL = bgc("#2a3050"), bgc("#7aa2f7") + rgb("#15161e")
STOP_NEEDS_UPDATE = ("this a4sx can't stop the agent host from here (that needs a4sx 0.59.10 or newer): run `a4sx update`, "
                     "or stop it with Ctrl-C in its tab; nothing was stopped")
SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
ANSI = re.compile(r"\x1b\[[0-9;]*m")
#: the a4sx CLI's own cell-name rule (MESH_CELL_NAME_RE): what may be typed into a shell as a cell's name
CELL_NAME_RE = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?")
#: a4sx #2309 (bb): what a fresh host shows instead of an empty list, in the CLI's own words (`mesh cells`, no cells)
FIRST_CELL_LINES = [
    "",
    "  No cell on this host yet. To start your first one, in a project folder:",
    "",
    "      a4sx launch --cell",
    "",
    "  It claims a new cell in your browser (`a4sx launch --cell -` starts one with a code from the console).",
    "  f starts it here, in a new tab in ~/projects/<name>; name the folder like the cell you will claim.",
    "  A cell of yours on another host: view 5, n brings it here by its name.",
]


def vlen(s):
    return len(ANSI.sub("", s))


def fit(s, n):
    """Exactly n visible columns: cut (keeping colours closed) or pad."""
    if vlen(s) <= n:
        return s + " " * (n - vlen(s))
    out, seen, i = [], 0, 0
    while i < len(s) and seen < n - 1:
        m = ANSI.match(s, i)
        if m:
            out.append(m.group(0))
            i = m.end()
        else:
            out.append(s[i])
            seen, i = seen + 1, i + 1
    return "".join(out) + RS + DIM + "…" + RS


def box(title, lines, w, h, accent=BLUE, hint=""):
    """A rounded panel of w x h cells."""
    inner = w - 2
    t = f" {title} "
    top = f"{FAINT}╭─{RS}{accent}{B}{t}{RS}{FAINT}{'─' * max(0, inner - len(t) - 1)}╮{RS}"
    body = [f"{FAINT}│{RS}{fit(' ' + ln, inner)}{FAINT}│{RS}" for ln in lines[: h - 2]]
    body += [f"{FAINT}│{RS}{' ' * inner}{FAINT}│{RS}"] * (h - 2 - len(body))
    hb = f" {hint} " if hint else ""
    bot = f"{FAINT}╰{'─' * max(0, inner - len(hb) - 1)}{RS}{DIM}{hb}{RS}{FAINT}{'─' if hb else '─'}╯{RS}" if hb else f"{FAINT}╰{'─' * inner}╯{RS}"
    return [top] + body + [bot]


def side(a, b, gap=1):
    n = max(len(a), len(b))
    wa = vlen(a[0]) if a else 0
    a = a + [" " * wa] * (n - len(a))
    b = b + [""] * (n - len(b))
    return [x + " " * gap + y for x, y in zip(a, b)]


#: when a command last came back with the server's rate_limited (the sign-in may ask about 60 times a minute)
LIMITED = [0.0]
#: seconds between refreshes. LOCAL asks nothing of the server; SERVER costs about 3 requests, RARE about 3 more
T_LOCAL, T_SERVER, T_RARE, T_BACKOFF, T_BACKOFF_MAX = 5, 60, 300, 90, 600


def run(argv, timeout=30, cwd=None):
    try:
        r = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL, cwd=cwd,
                           encoding="utf-8", errors="replace", env={**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"})
        if r.returncode and "rate_limited" in (r.stderr + r.stdout):
            LIMITED[0] = time.time()
        return r.returncode, r.stdout, r.stderr
    except (OSError, subprocess.TimeoutExpired) as e:
        return 1, "", f"{type(e).__name__}: {' '.join(argv[:3])}"


def jrun(argv, timeout=30):
    out = run(argv, timeout)[1]
    try:
        return json.loads(out[out.index("{"):])
    except ValueError:
        return {}


def lines_of(res, empty="(no output)"):
    rc, out, err = res
    txt = [x.rstrip() for x in (out + ("\n" + err if err.strip() else "")).splitlines() if x.strip()]
    return txt or [empty if rc == 0 else f"{empty} (exit {rc})"]


def _cell_panes_path():
    """cell01: the pane each cell was last started in from the deck, per herdr session ({cell: [pane, tab]})."""
    return _marker()[:-len(".txt")].replace("pane-", "cells-", 1) + ".json"


def _cell_panes():
    try:
        with open(_cell_panes_path(), encoding="utf-8") as f:
            v = json.load(f)
        return v if isinstance(v, dict) else {}
    except (OSError, ValueError):
        return {}


def _remember_cell_pane(cell, pane, tab):
    got = _cell_panes()
    got[cell] = [pane, tab]
    _save_cell_panes(got)


def _save_cell_panes(got):
    try:
        os.makedirs(os.path.dirname(_cell_panes_path()), exist_ok=True)
        tmp = _cell_panes_path() + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(dict(list(got.items())[-64:]), f)
        os.replace(tmp, _cell_panes_path())
    except OSError:
        pass   # only a convenience: the next start opens a new tab


def _leftover_pane(cell):
    """cell01 (after a herdr restart the cell's old pane stays as an empty shell): the pane the deck last started this
    cell in, when herdr still has it in the same tab and no agent runs in it; else None. Like the deck's own restored
    pane, never a pane herdr can't answer for."""
    pane, tab = (_cell_panes().get(cell) or [None, None])[:2]
    if not pane or not tab:
        return None
    info = (jrun([HERDR, "pane", "get", pane], 8).get("result") or {}).get("pane")
    if not isinstance(info, dict) or info.get("agent") or info.get("agent_session"):
        return None
    if info.get("tab_id", tab) != tab:
        return None
    if "tab_id" not in info:   # not in pane get's answer: the pane list says which tab it is in
        panes = (jrun([HERDR, "pane", "list"], 8).get("result") or {}).get("panes") or []
        if not any(p.get("pane_id") == pane and p.get("tab_id") == tab for p in panes):
            return None
    return pane, tab


#: 0.4.7: the CLI's per-cell record of its last session's id and folder (a4sx CELL_LAST_SESSION_FILE; no credential)
CELL_LAST_FILE = "cell-last-session.json"


def recorded_cwd(name, iid):
    """0.4.7 (cell01): the folder this cell's last session ran in, from the CLI's own record on this host
    (state/a4sx/agents/<name>/state, CELL_LAST_FILE, entry by instance id), when it is a folder here; else None.
    A cell's tab isn't always in ~/projects/<cell>."""
    if not CELL_NAME_RE.fullmatch(str(name or "")) or not isinstance(iid, str) or not iid:
        return None
    try:   # review: a regular file only (a FIFO would hang the read, as the CLI's pf_open_regular guards), 1 MiB at most
        fd = os.open(os.path.join(STATE, "a4sx", "agents", name, "state", CELL_LAST_FILE),
                     os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_NOFOLLOW", 0))
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                return None
            raw = os.read(fd, 1 << 20)
        finally:
            os.close(fd)
        got = json.loads(raw.decode("utf-8"))
    except (OSError, ValueError, UnicodeDecodeError):
        return None
    e = ((got.get("cells") if isinstance(got, dict) else None) or {}).get(iid) if isinstance(got, dict) else None
    cwd = e.get("cwd") if isinstance(e, dict) else None
    return cwd if isinstance(cwd, str) and os.path.isabs(cwd) and os.path.isdir(cwd) else None


def running_cwd(name, iid, pid):
    """0.4.10: the folder a running cell works in. First its launch process's current folder (Linux /proc, own
    processes only): the launch moves into the conversation's folder and Claude Code inherits it, on every a4sx.
    Review: only then a4sx's record (recorded_cwd), which an a4sx before 0.59.21 doesn't write at every start, so it
    can name an old folder. None when neither is known."""
    if isinstance(pid, int) and not isinstance(pid, bool) and pid > 1:
        try:
            here = os.path.realpath(os.readlink(f"/proc/{pid}/cwd"))
            if os.path.isdir(here):
                return here
        except (OSError, ValueError):
            pass
    return recorded_cwd(name, iid) if CELL_NAME_RE.fullmatch(str(name or "")) else None


def _pane_idle_in(pane, cwd):
    """0.4.8: `pane` shows a bare shell prompt in `cwd` (its shell's /proc/<pid>/cwd) and has no agent. Linux only."""
    pid = _idle_shell_pid(pane) if isinstance(pane, str) else None
    try:
        here = os.path.realpath(os.readlink(f"/proc/{int(pid)}/cwd")) if pid else None
        return here is not None and here == os.path.realpath(cwd) and not _pane_has_agent(pane)
    except (OSError, ValueError):
        return False


def _pane_in_folder(cwd, skip_tab=None, skip_pane=None):
    """0.4.7 (cell01): a herdr pane that shows a bare shell prompt in `cwd` (its shell's own folder, /proc/<pid>/cwd)
    and has no agent: the cell's old tab when the deck has no record of it. (pane, tab), or None. Linux only."""
    if not cwd:
        return None
    try:
        want = os.path.realpath(cwd)
    except OSError:
        return None
    panes = (jrun([HERDR, "pane", "list"], 8).get("result") or {}).get("panes") or []
    for p in panes:
        pane, tab = p.get("pane_id"), p.get("tab_id")
        if not isinstance(pane, str) or not tab or tab == skip_tab or pane == skip_pane:
            continue
        pid = _idle_shell_pid(pane)
        try:
            here = os.path.realpath(os.readlink(f"/proc/{int(pid)}/cwd")) if pid else None
        except (OSError, ValueError):
            here = None
        if here == want and not _pane_has_agent(pane):
            return pane, tab
    return None


#: the shells whose bare prompt counts as idle (process-info's foreground process name)
IDLE_SHELLS = ("bash", "zsh", "fish", "sh")


def _idle_shell_pid(pane):
    """The shell's pid when the pane shows a bare shell prompt (see pane_is_idle_shell), else None."""
    info = (jrun([HERDR, "pane", "process-info", "--pane", pane], 8).get("result") or {}).get("process_info")
    if not isinstance(info, dict):
        return None
    sp, fg, procs = info.get("shell_pid"), info.get("foreground_process_group_id"), info.get("foreground_processes")
    if not isinstance(sp, int) or isinstance(sp, bool) or fg != sp or not isinstance(procs, list) or len(procs) != 1:
        return None
    p = procs[0] if isinstance(procs[0], dict) else {}
    return sp if p.get("pid") == sp and os.path.basename(str(p.get("name") or "")).lstrip("-") in IDLE_SHELLS else None


def _shell_children(pid):
    """The shell's child processes (Linux /proc), or None when that can't be read."""
    try:
        with open(f"/proc/{int(pid)}/task/{int(pid)}/children", encoding="ascii") as f:
            return f.read().split()
    except (OSError, ValueError):
        return None


def pane_is_empty_shell(pane):
    """Review of #6: closable only when the shell shows a bare prompt AND has no child at all (a vim suspended with
    Ctrl-Z, `npm run dev &`, an ssh tunnel are children). Unreadable counts as busy."""
    sp = _idle_shell_pid(pane)
    return sp is not None and _shell_children(sp) == []


def _item_key(x):
    """0.4.8: what a list row is, across refreshes: its kind, name and instance id."""
    return (x.get("kind"), x.get("name"), x.get("iid")) if isinstance(x, dict) else None


def runs_elsewhere(r):
    """0.4.6 (r): your cell, stored here too, online and not running on this host: it runs on another host now."""
    return bool(r.get("here") and r.get("mine") and r.get("presence") == "online" and not r.get("running"))


def of_cell(saved, cell):
    """0.4.6 (q): a save of this cell, by the names the front ends give them (`<cell>-backup`, `handoff-<cell>`)."""
    return bool(cell) and saved in (f"{cell}-backup", f"handoff-{cell}", cell)   # review: exact names, not a prefix


def own_messages(d, cell, n=12):
    """0.4.6: a running cell's own last deliveries, from the records the deck reads anyway (newest first)."""
    with d.lock:
        acts = [a for a in d.activity if a[2] == cell][:n]
        read = getattr(d, "activity_read", True)
    if not acts:
        return ["no messages recorded on this host for this cell yet" if read else "reading this host's delivery records …"]
    return [f"{time.strftime('%m-%d %H:%M', time.localtime(at))}  {'from' if way == 'in' else 'to  '} {peer}  {status}"
            for at, way, _c, peer, status in acts]


def restore_order(lib, cell):
    """0.4.6 (q): newest first ("YYYY-MM-DD HH:MM" sorts as text)."""
    return sorted(lib, key=lambda x: x.get("updated") or "", reverse=True)


def _ancestors(pid, n=16):
    """pid and its parents, nearest first (Linux /proc), at most n; [] when they can't be read."""
    out, cur = [], pid
    for _ in range(n):
        if not isinstance(cur, int) or isinstance(cur, bool) or cur <= 1 or cur in out:
            break
        out.append(cur)
        try:
            with open(f"/proc/{int(cur)}/stat", encoding="ascii", errors="replace") as f:
                cur = int(f.read().rsplit(")", 1)[1].split()[1])
        except (OSError, ValueError, IndexError):
            break
    return out


#: 0.4.5: each agent pane's shell pid (it doesn't change while the pane lives), and {cell pid: pane or None} for the
#: agent pane set it was looked up in: herdr is asked again only for a new pane or a new cell process (review of #9)
_SHELL_OF_PANE: dict = {}
_PANE_OF_PID: dict = {}


def _process_info(pane):
    info = (jrun([HERDR, "pane", "process-info", "--pane", pane], 8).get("result") or {}).get("process_info")
    return info if isinstance(info, dict) else {}


def _shell_pid_of(pane):
    """The pane's shell pid, asked once per pane (review: a failed answer is not kept, so it is asked again)."""
    if pane not in _SHELL_OF_PANE:
        sp = _process_info(pane).get("shell_pid")
        if not isinstance(sp, int) or isinstance(sp, bool):
            return None
        _SHELL_OF_PANE[pane] = sp
    return _SHELL_OF_PANE[pane]


def _in_foreground(pid, pane):
    """Review of #9: the cell's launch is the pane's foreground job (its process group is the pane's foreground one),
    not merely a descendant of that shell (an agent host started there runs its cells in other groups)."""
    try:
        return os.getpgid(pid) == _process_info(pane).get("foreground_process_group_id")
    except (OSError, ProcessLookupError):
        return False


def pane_of_pid(pid, agents, taken=()):
    """0.4.5 (cell01: «omarchy-cell» ran in a pane of this herdr session, shown "here, no pane"): a cell whose folder isn't
    named after it is found by its process: the agent pane whose shell is the NEAREST of the launch's ancestors (review:
    a launch started from inside another agent's pane, e.g. its Bash tool, passes through that pane's shell further up).
    Panes in `taken` (matched to a cell by its folder) are never given to another cell: when the nearest one is taken,
    the answer is None, never a pane further up. None too when no pane holds it."""
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 1:
        return None
    panes = tuple(sorted(a.get("pane_id") for a in agents if a.get("pane_id")))
    key = (panes, tuple(sorted(taken)))
    for gone in [p for p in _SHELL_OF_PANE if p not in panes]:
        _SHELL_OF_PANE.pop(gone, None)
    hit = _PANE_OF_PID.get(pid)
    if hit is not None and hit[0] == key:   # a hit or a miss for this very pane set
        return hit[1]
    shells = {}
    for pane in panes:
        sp = _shell_pid_of(pane)
        if sp is not None:
            shells.setdefault(sp, pane)
    found = next((shells[p] for p in _ancestors(pid) if p in shells), None)
    if found in taken or (found is not None and not _in_foreground(pid, found)):
        found = None
    _PANE_OF_PID[pid] = (key, found)
    return found


def pane_is_idle_shell(pane):
    """cell01 (herdr 0.9.5 `pane process-info --pane <id>`): True only when the pane shows a bare shell prompt: the
    foreground process group is the shell's own, it is the one foreground process, and it is a known shell. Anything
    else (a program in front, a nested shell, an unknown shape, an error) is False, and the deck asks instead."""
    return _idle_shell_pid(pane) is not None


#: the names a VS Code request may carry for a saved conversation: plain, so no shell or terminal reads them otherwise
VSC_NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
#: the starts VS Code runs for the deck (the extension checks the same): the flags of `a4sx launch` it sends
VSC_SHAPES = (frozenset({"--cell"}), frozenset({"--cell", "--new-session"}), frozenset({"--cell", "--a4sx-session"}),
              frozenset({"--a4sx-session"}))


def vscode_request_args(rest):
    """`rest`: the a4sx arguments of a start. The same arguments when VS Code runs that shape for the deck: `launch`
    with --cell [<cell>], --new-session, --a4sx-session <saved>, each once, in a shape the deck sends. None for
    anything else (it is shown to run by hand)."""
    if not isinstance(rest, list) or not rest or rest[0] != "launch":
        return None
    seen, i = set(), 1
    while i < len(rest):
        a = rest[i]
        if not isinstance(a, str) or a in seen or a not in ("--cell", "--new-session", "--a4sx-session"):
            return None
        seen.add(a)
        nxt = rest[i + 1] if i + 1 < len(rest) else None
        if a == "--cell" and isinstance(nxt, str) and not nxt.startswith("-"):
            if not CELL_NAME_RE.fullmatch(nxt):
                return None
            i += 2
        elif a == "--a4sx-session":
            if not (isinstance(nxt, str) and VSC_NAME_RE.fullmatch(nxt)):
                return None
            i += 2
        else:
            i += 1
    return list(rest) if frozenset(seen) in VSC_SHAPES else None


def vscode_plain_folder(cwd):
    """A folder VS Code may start in for the deck: no control, format or line-separator characters (the extension's
    own check refuses the same, and says so instead of showing the command)."""
    import unicodedata
    return not any(unicodedata.category(ch) in ("Cc", "Cf", "Zl", "Zp", "Co") for ch in cwd)


def vscode_folder_ok(cwd):
    """A folder VS Code starts a cell in for the deck (the extension checks the same): plain, inside the home folder or
    one of the window's workspace folders (links resolved), not writable by every user, not on a network share."""
    if not vscode_plain_folder(cwd) or not os.path.isabs(cwd) or (WIN and cwd[:2] in ("\\\\", "//")):
        return False
    try:
        real = os.path.realpath(cwd)
        st = os.stat(real)
    except OSError:
        return False
    if not stat.S_ISDIR(st.st_mode) or (not WIN and st.st_mode & 0o002):
        return False

    def inside(root):
        try:
            r = os.path.realpath(root)
            return os.path.normcase(os.path.commonpath([r, real])) == os.path.normcase(r)
        except (OSError, ValueError):   # another drive
            return False
    return any(inside(r) for r in [os.path.expanduser("~"), *_VSC_FOLDERS])


def vscode_request(label, cwd, rest):
    """One request file in the extension's channel folder, written whole before it appears (the extension reads,
    deletes and checks it)."""
    # review: plain ASCII only (a terminal's name; no right-to-left or zero-width characters), as the extension takes
    label = "".join(ch for ch in ANSI.sub("", str(label)) if " " <= ch <= "~")[:40].strip() or "a4sx"
    req = {"v": 1, "nonce": _VSC_NONCE, "label": label, "cwd": os.path.abspath(cwd), "args": rest}
    name = f"req-{time.time_ns()}-{os.getpid()}.json"
    tmp = os.path.join(_VSC_CHANNEL, "." + name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(req, f)
    os.replace(tmp, os.path.join(_VSC_CHANNEL, name))
    return label


def new_tab(label, cwd, argv, cell=None, reuse=None, own=False):
    """A new herdr tab running argv. `cell`: a cell's start: its name must follow the CLI's rule, and its pane is
    remembered for the next time. `reuse`: (pane, tab) of the cell's leftover shell from before a herdr restart, which
    herdr's process-info shows as a bare shell prompt, or the person said is one (pane_is_idle_shell can't tell); it is
    checked again, and a failed run there opens a new tab. Everything typed into a shell is shlex-quoted (POSIX:
    herdr's panes are on Linux)."""
    if cell is not None and not CELL_NAME_RE.fullmatch(str(cell)):
        return f"«{ANSI.sub('', str(cell))[:64]}» isn't a cell name a4sx takes, so nothing was started"
    os.makedirs(cwd, exist_ok=True)
    shown = ("a4sx " + " ".join(argv[len(A4SX_ARGV):])) if argv[:len(A4SX_ARGV)] == A4SX_ARGV else " ".join(argv)
    if VSCODE:   # 0.5.0: a VS Code terminal, opened by the extension; anything else is shown to run by hand
        rest = vscode_request_args(argv[len(A4SX_ARGV):]) if argv[:len(A4SX_ARGV)] == A4SX_ARGV else None
        if rest is None or not vscode_folder_ok(cwd):   # follow-up (c): what VS Code would refuse is shown here
            return f"run this in a terminal, in {cwd}:  {shown}"
        try:
            label = vscode_request(label, cwd, rest)
        except OSError as e:
            return f"could not ask VS Code to open a terminal for: {shown} ({e.__class__.__name__})"
        return f"asked VS Code to open the terminal «a4sx: {label}» (it shows the outcome): {shown}"
    if not IN_HERDR:
        if not WIN:
            return f"run this in a terminal, in {cwd}:  {shown}"
        ps = "& " + " ".join("'" + a.replace("'", "''") + "'" for a in argv)
        pre = os.environ.get("DECK_PATH_PREFIX")   # test rigs: a stand-in Claude Code first on PATH in the new tab
        if pre:
            ps = "$env:PATH = '" + pre.replace("'", "''") + ";' + $env:PATH; " + ps
        wt = shutil.which("wt.exe") or shutil.which("wt")
        # encoded: Windows Terminal splits its own command line at every ';', and cmd has its own quoting rules
        enc = base64.b64encode(ps.encode("utf-16-le")).decode("ascii")
        cmd = ([wt, "-w", "0", "new-tab", "--title", label, "-d", cwd, "powershell.exe", "-NoExit", "-NoProfile", "-EncodedCommand", enc] if wt
               else ["cmd.exe", "/c", "start", label, "/D", cwd, "powershell.exe", "-NoExit", "-NoProfile", "-EncodedCommand", enc])
        try:
            subprocess.Popen(cmd, cwd=cwd)
        except OSError as e:
            return f"could not open a terminal for: {shown} ({e.__class__.__name__})"
        return f"opened the terminal tab «{label}»: {shown}"
    if any("\\" in a or "\n" in a or "\r" in a for a in (cwd, *argv)):
        # review: fish reads \\ and \' inside single quotes, so shlex's quoting isn't safe there; nothing is typed
        return f"a backslash or line break in the folder or the command can't be typed into herdr's shell safely, so nothing was started: {shown}"
    old = _leftover_pane(cell) if (cell and reuse) else None
    if reuse and not (old and tuple(old) == tuple(reuse)):   # 0.4.7/0.4.8: or that very pane, an idle shell in cwd
        # 0.4.10 (review): the cell's provably own pane (its launch ran in it) only needs a bare prompt and no agent;
        # its shell sits in the tab's folder, not the cell's work folder, and `cd` comes first in the typed line
        ok = (pane_is_idle_shell(reuse[0]) and not _pane_has_agent(reuse[0])) if own else _pane_idle_in(reuse[0], cwd)
        old = tuple(reuse) if ok else None
    if old and tuple(old) == tuple(reuse):
        pane, tab = old
        # follow-up (c): a half-typed line would prefix the start line; ctrl+u clears it, sent only when herdr's
        # process-info shows the bare shell (in less or vim the key means something else)
        if pane_is_idle_shell(pane):
            run([HERDR, "pane", "send-keys", pane, "ctrl+u"], 8)
        # the shell may be in another folder: cd first, in the same line
        if run([HERDR, "pane", "run", pane, "cd " + shlex.quote(cwd) + " && " + " ".join(shlex.quote(a) for a in argv)])[0] == 0:
            run([HERDR, "tab", "focus", tab])
            if cell:   # 0.4.9 (cell01): a reused tab is the cell's tab from now on, as a new one is
                _remember_cell_pane(cell, pane, tab)
            # 0.4.5 (cell01): the CLI may still refuse in it, so this says what was done, not that it started
            return f"ran the start in its tab «{label}» again (the tab shows the outcome): {shown}"
    d = jrun([HERDR, "tab", "create", "--cwd", cwd, "--label", label, "--focus"]).get("result") or {}
    pane, tab = (d.get("root_pane") or {}).get("pane_id"), (d.get("tab") or {}).get("tab_id")
    if not pane:
        return f"herdr could not open a tab for: {' '.join(argv)}"
    run([HERDR, "pane", "run", pane, " ".join(shlex.quote(a) for a in argv)])
    if tab:
        run([HERDR, "tab", "focus", tab])
        if cell:
            _remember_cell_pane(cell, pane, tab)
    return f"opened the tab «{label}» (it shows the outcome): {shown}"


#: panes this deck has seen with a cell's name: {pane: cell}
LABELED = {}
#: the sources that put a cell's name on a pane: the deck's own and `a4sx launch`'s (HERDR_META_SOURCE in the CLI)
LABEL_SOURCES = ("a4sx-deck", "a4sx-launch")


def remember_running_panes(rows):
    """0.4.9 (cell01: two tabs «omarchy-cell», the restore took the other one): the pane a cell is SEEN running in is
    its tab from now on, as one the deck opened: a later restore of the stopped cell reuses that tab."""
    rec = _cell_panes()
    # review: only a pane found by the launch's own process; a folder-name match can be another tab or a plain
    # Claude Code session in ~/projects/<cell>, and a recorded pane is later reused with no question
    want = {r["name"]: r["pane"] for r in rows if r.get("running") and r.get("pane") and r.get("pane_by") == "pid"
            and CELL_NAME_RE.fullmatch(str(r.get("name") or ""))
            and (rec.get(r["name"]) or [None])[0] != r["pane"]}
    if not want:
        return
    panes = (jrun([HERDR, "pane", "list"], 8).get("result") or {}).get("panes") or []
    tab_of = {p.get("pane_id"): p.get("tab_id") for p in panes}
    for name, pane in want.items():
        if tab_of.get(pane):
            _remember_cell_pane(name, pane, tab_of[pane])


def label_panes(rows, cells=(), clear=True):
    """Each running cell's name on its pane; cell01: a pane whose cell left it (moved away, stopped) loses that name.
    herdr 0.9.5 clears a label only for the source that set it, so both sources are cleared."""
    now = {}
    for r in rows:
        if r.get("pane"):   # pane id first; a source id with a dot is read as an option by herdr 0.9.5
            now[r["pane"]] = r["name"]
            if LABELED.get(r["pane"]) != r["name"]:
                run([HERDR, "pane", "report-metadata", r["pane"], "--source", "a4sx-deck", "--display-agent", r["name"]], 8)
    # a cell that still runs but isn't in these rows (another mesh's) keeps its pane's name
    running = {c.get("name") for c in cells if (c.get("local") or {}).get("state") == "running"}
    shown = {r["name"] for r in rows}
    for pane in [p for p in LABELED if p not in now]:
        if not clear or (LABELED[pane] in running and LABELED[pane] not in shown):
            now[pane] = LABELED[pane]
            continue
        for src in LABEL_SOURCES:
            run([HERDR, "pane", "report-metadata", pane, "--source", src, "--clear-display-agent"], 8)
    LABELED.clear()
    LABELED.update(now)


# ---------------------------------------------------------------- the deck as the first thing a herdr session shows
DECK_TITLE = "a4sx deck"
#: cell01: below this the boxes overlap; the deck then shows one plain line what to do
DECK_MIN_W, DECK_MIN_H = 100, 20


def narrow_screen(w, h):
    """What a pane too small for the deck shows: the size it has and needs, and what to do (plain text, short lines)."""
    return ["a4sx deck", "", f"this pane is {w}×{h};", f"the deck needs {DECK_MIN_W + 1}×{DECK_MIN_H}.", "",
            "make the pane wider", "(or zoom it in herdr);", "q closes the deck"]


def _marker():
    """Where a running deck writes its pane id down, one file per herdr session (a session is one socket)."""
    import hashlib
    key = hashlib.sha256((os.environ.get("HERDR_SOCKET_PATH") or "default").encode()).hexdigest()[:12]
    return os.path.join(STATE or os.path.expanduser("~"), "a4sx-deck", f"pane-{key}.txt")


def _deck_alive(pid):
    """True when process `pid` is a deck (its command line names this file); a restored herdr session keeps the
    deck's pane as an empty shell, and a pid can be given to another program."""
    try:
        with open(f"/proc/{int(pid)}/cmdline", "rb") as f:
            return os.path.basename(__file__).encode() in f.read()
    except (OSError, ValueError):
        return False


def deck_state():
    """(pane id, tab id, alive) of this herdr session's deck. The pane the deck wrote down, alive or left over by a
    restored session; else a pane with the deck's title; else (None, None, False)."""
    panes = (jrun([HERDR, "pane", "list"], 8).get("result") or {}).get("panes") or []
    try:
        with open(_marker(), encoding="utf-8") as f:
            mine, _, pid = f.read().strip().partition(" ")
    except OSError:
        mine, pid = "", ""
    pid, _, tab = pid.partition(" ")
    for p in panes:
        if mine and p.get("pane_id") == mine:
            alive = _deck_alive(pid)
            # review: a pane id comes back for other panes: only the deck's own restored pane (the same tab, no agent
            # in it) is taken as the deck's; anything else means the marker is stale, and it is dropped
            if alive or (tab and p.get("tab_id") == tab and not _pane_has_agent(mine)):
                return mine, p.get("tab_id"), alive
            _drop_marker()
            break
    for p in panes:
        if (p.get("terminal_title_stripped") or "") == DECK_TITLE:
            return p.get("pane_id"), p.get("tab_id"), True
    return None, None, False


def _pane_has_agent(pane):
    """Review: whether herdr knows an agent in `pane` (`herdr pane get`: result.pane.agent / agent_session, the shape
    a4sx's own herdr check reads live). No answer counts as an agent: never type into a pane that can't be checked."""
    got = jrun([HERDR, "pane", "get", pane], 8)
    info = (got.get("result") or {}).get("pane") if isinstance(got, dict) else None
    if not isinstance(info, dict):
        return True
    return bool(info.get("agent") or info.get("agent_session"))


def _drop_marker():
    try:
        os.remove(_marker())
    except OSError:
        pass


def deck_pane_id():
    """The pane a deck runs in now, in this herdr session, or None."""
    pane, _, alive = deck_state()
    return pane if alive else None


def _setting(env, name):
    """A deck setting: the environment variable `env`, else the one word in the file `name` of the plugin's config
    folder ("" when neither)."""
    v = os.environ.get(env, "").strip().lower()
    if not v:
        d = os.environ.get("HERDR_PLUGIN_CONFIG_DIR") or os.path.join(
            os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), "herdr", "plugins", "config", PLUGIN_ID)
        try:
            with open(os.path.join(d, name), encoding="utf-8") as f:
                v = f.read().strip().lower()
        except OSError:
            v = ""
    return v


def on_start_mode():
    """What herdr's start does: "focus" (the default: the deck is the first thing shown), "open" (a tab, not focused)
    or "off". From DECK_ON_START, else the one word in the plugin's config folder, file `on-start`."""
    v = _setting("DECK_ON_START", "on-start")
    return v if v in ("focus", "open", "off") else "focus"


#: cell01 (#2309): how the deck uploads a conversation, a setting instead of a question each time. "as it is"
#: (--no-scrub) is left out until a4sx #2292: the server scrubs every push today, so it wouldn't be as it is.
UPLOAD_MODES = {"scrubbed": ("", "scrubbed (secrets, personal data, host names and paths removed)"),
                "keep-names": ("--keep-pii", "names, hosts and paths kept on this computer (the server still redacts "
                                             "them until a4sx #2292); secrets removed")}


def upload_mode():
    """The `upload` setting (DECK_UPLOAD, else the file `upload`): "scrubbed" (the default) or "keep-names"."""
    v = _setting("DECK_UPLOAD", "upload")
    return v if v in UPLOAD_MODES else "scrubbed"


def open_deck(focus=True):
    """Focus the deck of this herdr session, or open it as a tab when none runs. Never a second one."""
    pane, tab, alive = deck_state()
    if pane and not alive:
        # the deck's own pane, left as a shell by a restored session: the deck starts in it again
        me = os.path.abspath(__file__)
        rc = run([HERDR, "pane", "run", pane, "exec " + " ".join(shlex.quote(a) for a in (sys.executable or "python3", me, "pane"))])[0]
        if rc == 0:
            alive = True
    if pane and alive:
        return run([HERDR, "tab", "focus", tab])[0] if (focus and tab) else 0
    rc = run([HERDR, "plugin", "pane", "open", "--plugin", PLUGIN_ID, "--entrypoint", "deck"] + (["--focus"] if focus else []))[0]
    if rc == 0 and focus:
        # cell01 (herdr 0.9.5): `plugin pane open --focus` marks the new tab focused, but an attached window keeps showing
        # the tab it was on; `tab focus` is what switches it (seen on start and on the "open" action)
        for _ in range(12):
            time.sleep(0.25)
            tab = deck_state()[1]
            if tab:
                run([HERDR, "tab", "focus", tab], 8)
                break
    return rc


def start():
    """herdr's startup hook. With the deck switched off it only names the cells in the agents list, as before."""
    mode = on_start_mode()
    if mode == "off":
        Data().refresh()
        return 0
    if not deck_state()[0]:
        time.sleep(1.5)   # a restored session may be bringing its panes back right now
    rc = open_deck(mode == "focus")
    if mode == "focus":
        # herdr runs this before the window has attached, and an attaching window shows its first tab: the deck's
        # tab is put in front again once it is there (seen with herdr 0.9.5; two tries, then the user is left alone)
        for wait in (1.0, 2.5):
            time.sleep(wait)
            tab = deck_state()[1]
            if tab:
                run([HERDR, "tab", "focus", tab], 8)
    return rc


def herdr_keys():
    """The user's own herdr keys from config.toml's [keys] (only what is set there), as (keys, what it does)."""
    path = os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), "herdr", "config.toml")
    keys, inside = {}, False
    try:
        with open(path, encoding="utf-8") as f:
            for raw in f:
                ln = raw.strip()
                if ln.startswith("["):
                    inside = ln == "[keys]"
                    continue
                m = re.match(r"^([a-z_0-9]+)\s*=\s*(.+)$", ln) if inside else None
                if m:
                    vals = re.findall(r'"([^"]+)"', m.group(2))
                    if vals:
                        keys[m.group(1)] = vals
    except OSError:
        return []
    prefix = (keys.get("prefix") or [""])[0]
    wanted = (("switch_tab", "go to a tab"), ("new_tab", "new tab"), ("previous_tab", "previous tab"), ("next_tab", "next tab"),
              ("split_horizontal", "split the pane"), ("close_pane", "close the pane"), ("zoom", "zoom the pane"),
              ("detach", "detach (herdr keeps running)"), ("help", "herdr's own help"))
    # the first binding of each, "prefix+c" written as "prefix c"; the prefix itself comes first
    out = [("prefix", prefix)] if prefix else []
    out += [(keys[name][0].replace("prefix+", "prefix "), what) for name, what in wanted if name in keys]
    return out


class Data:
    def __init__(self):
        self.lock = threading.Lock()
        self.busy = threading.Lock()              # one refresh at a time
        self.at, self.mesh, self.mesh_id, self.role = None, None, None, ""
        self.members, self.rows, self.cells, self.agents, self.requests, self.library = [], [], [], [], [], []
        self.mine = {}
        self.activity, self.n = [], 0
        self.activity_read = False                # 0.4.6 (cell01): "reading…" until the first read of the records
        self.ah = {"running": False, "address": "", "known": False, "open": []}
        self.peers = []
        self.t_server = self.t_rare = self.t_act = 0.0
        self.slow_until, self.backoff, self.seen_limit = 0.0, T_BACKOFF, 0.0
        self.stale = ""                           # why the server data is old, when it is

    @property
    def ref(self):
        """The mesh as commands take it: its id (no name lookup at the server), else its name."""
        return self.mesh_id or self.mesh

    def load_activity(self, mesh, rows):
        """The last messages between this host's cells and every peer (from the local delivery records)."""
        acts = []
        # 0.4.5 (cell01): every row but this host's running cells: after a round trip a peer is stored here too
        for r in sorted((x for x in rows if not x["running"]), key=lambda x: (x["here"], x["presence"] != "online"))[:12]:
            for c in jrun([*A4SX_ARGV, "mesh", "deliveries", r["iid"] or r["name"], "--mesh", mesh, "--last", "4", "--json"], 15).get("cells") or []:
                for x in c.get("rows") or []:
                    acts.append((x.get("at") or 0, x.get("dir"), c.get("cell"), x.get("peer") or r["name"], x.get("status") or ""))
        seen, out = set(), []
        for a in sorted(acts, reverse=True):
            k = (a[0], a[1], a[3])
            if k not in seen:
                seen.add(k)
                out.append(a)
        return out[:40]

    def load_library(self):
        res = run([*A4SX_ARGV, "list"])
        if res[0] != 0:
            return None
        lib = []
        for ln in res[1].splitlines():
            m = re.match(r"^\s*(\d+)\s+((?:[└├│─]\S*\s+)?)([A-Za-z0-9][A-Za-z0-9._@:+-]*)\s+(\d{4}-\d\d-\d\d \d\d:\d\d)\s+"
                         r"(\d{4}-\d\d-\d\d \d\d:\d\d)\s+(\d+)\s*(.*)$", ln)
            if m:
                rest = m.group(7).strip()
                sz = re.match(r"^(\d+[kM])\s+(.*)$", rest)
                lib.append({"child": bool(m.group(2).strip()), "name": m.group(3), "created": m.group(4), "updated": m.group(5),
                            "vers": m.group(6), "size": sz.group(1) if sz else "", "title": sz.group(2) if sz else rest})
        return lib

    def refresh(self, force="", wait=False):
        """force: "" = what is due, "server" = cells and peers now (after an operation), "all" = everything now.
        wait (0.4.9, cell01): after an operation, wait for a refresh already running and read again, instead of
        skipping (a stop showed "● running" with the old folder until the next round)."""
        if not self.busy.acquire(blocking=wait, timeout=30 if wait else -1):
            return
        try:
            self._refresh(force)
        finally:
            self.busy.release()

    def _refresh(self, force):
        now = time.time()
        # ---- local: no request to the server
        got_agents = jrun([HERDR, "agent", "list"]) if IN_HERDR else {}
        agents_ok = isinstance(got_agents.get("result"), dict)   # review: a failed list must not clear every name
        agents = (got_agents.get("result") or {}).get("agents") or [] if agents_ok else []
        ah = jrun([*A4SX_ARGV, "agent-host", "status", "--json"], 20)
        if ah or not self.ah["known"]:
            self.ah = {**ah, "running": bool(ah.get("running")), "address": ah.get("address") or "", "known": bool(ah),
                       "open": [str(x) for x in (ah.get("open") or [])]}
        # ---- the server said "slow down": wait, longer each time
        if LIMITED[0] > self.seen_limit:
            self.seen_limit = LIMITED[0]
            self.slow_until = now + self.backoff
            self.backoff = min(self.backoff * 2, T_BACKOFF_MAX)
        waiting = now < self.slow_until
        server_due = not waiting and (force in ("server", "all") or now - self.t_server >= T_SERVER)
        rare_due = not waiting and (force == "all" or now - self.t_rare >= T_RARE)
        cells, peers, members, reqs, lib = self.cells, self.peers, self.members, self.requests, self.library
        failed = []
        if server_due:
            self.t_server = now
            got = jrun([*A4SX_ARGV, "mesh", "cells", "--json"])
            if "cells" in got:
                cells = got["cells"] or []
            else:
                failed.append("cells")
        mine = next((c for c in cells if c.get("default")), cells[0] if cells else {}) or {}
        mesh, mesh_id = mine.get("mesh_name") or mine.get("mesh_id"), mine.get("mesh_id")
        ref = mesh_id or mesh
        if LIMITED[0] > self.seen_limit:   # told to slow down just now: nothing more this time
            server_due = rare_due = False
        if server_due and ref:
            got = jrun([*A4SX_ARGV, "mesh", "peers", ref, "--json"])
            if "peers" in got:
                peers = got["peers"] or []
            else:
                failed.append("peers")
        if LIMITED[0] > self.seen_limit:
            rare_due = False
        if rare_due and ref:
            self.t_rare = now
            got = jrun([*A4SX_ARGV, "mesh", "members", ref, "--json"])
            if "members" in got:
                members = got["members"] or []
            else:
                failed.append("members")
            got = self.load_library() if LIMITED[0] <= self.seen_limit else None
            if got is not None:
                lib = got
            else:
                failed.append("library")
        owner = {i.get("instance_id"): m for m in members for i in (m.get("instances") or [])}
        local = {c.get("instance_id"): c for c in cells}
        running = [c for c in cells if (c.get("local") or {}).get("state") == "running"]
        rows, seen = [], set()
        me = owner.get(mine.get("instance_id")) or {}
        if rare_due and ref and me.get("role") in ("owner", "admin") and LIMITED[0] <= self.seen_limit:
            got = jrun([*A4SX_ARGV, "mesh", "requests", ref, "--status", "pending", "--json", "--no-browser"])
            if "requests" in got:
                reqs = got["requests"] or []

        # 0.4.5 review: the panes a running cell has by its folder name are never given to another cell by process
        names_here = {c.get("name") for c in running}
        taken_by = {x.get("pane_id"): os.path.basename((x.get("cwd") or "").rstrip("/")) for x in agents
                    if os.path.basename((x.get("cwd") or "").rstrip("/")) in names_here}

        def row(name, iid, presence, own=None):
            m, c = owner.get(iid) or {}, local.get(iid)
            pane = state = cwd = by = None
            is_running = bool(c and (c.get("local") or {}).get("state") == "running")
            if is_running:
                # cell01: only an agent whose folder is named after the cell. Never "the one agent here": that put the
                # cell's name on a plain Claude Code pane of another herdr session's owner (seen 2026-11-21)
                # 0.4.8 (cell01: two tabs «omarchy-cell»): the pane its launch runs in first, by its process; only then
                # an agent whose folder is named after the cell
                pp = pane_of_pid((c.get("local") or {}).get("pid"), agents,
                                 {p for p, n in taken_by.items() if p and n != name}) if IN_HERDR else None
                a = next((x for x in agents if x.get("pane_id") == pp), None) if pp else None
                by = "pid" if a else None
                if a is None:
                    a = next((x for x in agents if os.path.basename((x.get("cwd") or "").rstrip("/")) == name), None)
                    by = "folder" if a else None
                if a:
                    pane, state, cwd = a.get("pane_id"), a.get("agent_status"), a.get("cwd")
                # 0.4.10 (cell01): where the cell works, not its tab's shell folder: a4sx's record (written at every
                # start since a4sx 0.59.21), else the launch's own folder (/proc), else the pane's
                cwd = running_cwd(name, iid, (c.get("local") or {}).get("pid")) or cwd
            elif c:   # 0.4.9 (cell01): a cell that doesn't run shows the folder its last session ran in (a4sx's record)
                cwd = recorded_cwd(name, iid) if CELL_NAME_RE.fullmatch(str(name or "")) else None
            return {"name": name, "iid": iid, "presence": presence or "?", "owner": m.get("display_name") or "?", "mine": bool(own) if own is not None else (bool(m) and m is me),
                    "role": m.get("role") or "", "here": bool(c), "running": is_running, "pane": pane, "pane_by": by, "state": state,
                    "cwd": cwd, "cell": c or {}}
        for p in peers:
            seen.add(p.get("instance_id"))
            rows.append(row(p.get("name"), p.get("instance_id"), p.get("presence"), p.get("own")))
        for c in cells:
            if c.get("instance_id") not in seen and (c.get("mesh_name") or c.get("mesh_id")) == mesh:
                rows.append(row(c.get("name"), c.get("instance_id"),
                                "online" if (c.get("local") or {}).get("state") == "running" else "offline"))
        rows.sort(key=lambda r: (not r["here"], r["presence"] != "online", r["name"] or ""))
        if IN_HERDR and server_due:
            label_panes(rows, cells, clear=agents_ok)
            remember_running_panes(rows)
        self.n += 1
        if not ref:   # review: no mesh, no records to read: the panel says "none yet", not "reading …" forever
            with self.lock:
                self.activity_read = True
        elif force or now - self.t_act >= T_SERVER:   # local delivery records, no server request
            self.t_act = now
            act = self.load_activity(ref, rows)
            with self.lock:
                self.activity, self.activity_read = act, True
        if LIMITED[0] > self.seen_limit:   # this very refresh was told to slow down
            self.seen_limit = LIMITED[0]
            self.slow_until = time.time() + self.backoff
            self.backoff = min(self.backoff * 2, T_BACKOFF_MAX)
        elif now - self.t_server < 1 and not failed:   # a server refresh went through: the next wait starts short again
            self.backoff = T_BACKOFF
        if time.time() < self.slow_until:
            stale = "the server asked to slow down: mesh data from " + (self.at or "before") + ", next try " + time.strftime("%H:%M:%S", time.localtime(self.slow_until))
        elif failed:
            stale = "no answer for " + ", ".join(failed) + ": showing the last good data"
        else:
            stale = "" if (now - self.t_server < 1 or not self.stale.startswith("no answer")) else self.stale
        with self.lock:
            if now - self.t_server < 1 and not failed and time.time() >= self.slow_until:
                self.at = time.strftime("%H:%M:%S")
            self.stale = stale
            self.mesh, self.mesh_id, self.members, self.rows, self.cells, self.peers = mesh, mesh_id, members, rows, cells, peers
            self.agents, self.requests, self.library, self.mine, self.role = agents, reqs, lib, mine, me.get("role") or ""


class Deck:
    def __init__(self):
        self.d = Data()
        self.view = "mesh"
        self.sel = {v: 0 for v in VIEWS}
        self.mode = "browse"                      # browse | input | pick
        self.pick, self.pick_title, self.pick_sel, self.pick_cb = [], "", 0, None
        self.inp, self.inp_title, self.inp_cb, self.inp_empty_ok = "", "", None, False
        self.out, self.out_title, self.msg, self.busy = [], "result", "loading…", False
        self.ops = []
        self.last_dot = 0.0
        self.herdr_keys = herdr_keys() if IN_HERDR else []   # read once: the first screen shows them

    # ------------------------------------------------------------ plumbing
    def items(self):
        d = self.d
        if self.view == "library":
            return d.library
        if self.view == "host":
            return [r for r in d.rows if r["here"]]
        if self.view == "move":
            # 0.4.6 (r): a cell stored here that runs on another host is listed with the cells on other hosts
            return ([{"kind": "cell", **r} for r in d.rows if r["here"] and not runs_elsewhere(r)]
                    + [{"kind": "away", **r} for r in d.rows if (not r["here"] or runs_elsewhere(r)) and r.get("mine")]
                    + [{"kind": "handoff", **x} for x in d.library if x["name"].startswith("handoff-")])
        return d.rows

    def keep_sel(self, its):
        """0.4.8 (cell01): the selection stays on the same cell when the list reorders (after a stop, a refresh): the
        next key acts on the row the person chose, not on whichever row moved into its place."""
        names = self.__dict__.setdefault("sel_key", {})
        if not its:
            return 0
        key = names.get(self.view)
        cur = min(self.sel[self.view], len(its) - 1)
        if key is not None and _item_key(its[cur]) != key:   # review: the row there now isn't the chosen one:
            hits = [k for k, x in enumerate(its) if _item_key(x) == key]   # the nearest row with its key
            if hits:
                self.sel[self.view] = min(hits, key=lambda k: abs(k - cur))
        i = min(self.sel[self.view], len(its) - 1)
        names[self.view] = _item_key(its[i])
        return i

    def cur(self):
        it = self.items()
        return it[self.keep_sel(it)] if it else None

    def note(self, lines, title="result"):
        self.out, self.out_title, self.msg = list(lines), title, ""

    def bg(self, title, fn):
        def work():
            self.busy, self.msg = True, title + " …"
            try:
                res = fn()
                if res is not None:   # review: an operation that showed its own note keeps it (no "None")
                    self.note(res if isinstance(res, list) else [str(res)], title)
            except Exception as e:   # noqa: BLE001 -- a prototype: say it, keep the screen
                self.msg = f"{title}: {e!r}"
            self.busy = False
            try:   # an operation changed something: cells and peers now, the library too when it was touched
                self.d.refresh("all" if any(w in title for w in ("backup", "hand-off", "fetch", "refresh")) else "server", wait=True)
            except Exception:   # noqa: BLE001
                pass
        threading.Thread(target=work, daemon=True).start()

    def ask(self, title, cb, empty_ok=False):
        self.mode, self.inp, self.inp_title, self.inp_cb, self.inp_empty_ok = "input", "", title, cb, empty_ok

    def choose(self, title, items, cb):
        self.mode, self.pick, self.pick_title, self.pick_sel, self.pick_cb = "pick", items, title, 0, cb

    def pdir(self, name):
        return os.path.join(os.path.expanduser("~"), "projects", name)

    def transcript(self, r):
        base = os.path.join(STATE, "a4sx", "harness", r["name"], "claude", "projects")
        files = glob.glob(os.path.join(base, "*", "*.jsonl"))
        for d in (r.get("cwd"), self.pdir(r["name"])):
            if d:
                slug = re.sub(r"[^A-Za-z0-9]", "-", d)
                mine = [f for f in files if os.path.basename(os.path.dirname(f)) == slug]
                if mine:
                    return max(mine, key=os.path.getmtime)
        return max(files, key=os.path.getmtime) if files else None

    def reload_library(self):
        """One `a4sx list` in the background (skipped while the server says "slow down")."""
        if LIMITED[0] > self.d.seen_limit or time.time() < getattr(self.d, "slow_until", 0):   # review: no call while slowed down
            return

        def work():
            got = self.d.load_library()
            if got is not None:
                self.d.library = got
        threading.Thread(target=work, daemon=True).start()

    def with_scrub(self, what, cb):
        """cell01: no question; the `upload` setting (shown in the op's label and the result) gives the flag."""
        return cb(UPLOAD_MODES[upload_mode()][0])

    def push(self, r, label, title, flag=""):
        """Save the cell's newest conversation under `label` (a new version when it exists). (ok, lines)"""
        f = self.transcript(r)
        if not f:
            return False, [f"no conversation file of {r['name']} found on this host"]
        exists = any(x["name"] == label for x in self.d.library)
        res = run([*A4SX_ARGV, "push", f] + (["--into", label] if exists else ["--label", label, "--title", title])
                  + ([flag] if flag else []), 240)
        txt = res[1] + res[2]
        st = re.search(r'"status":\s*"([^"]+)"', txt)
        nxt = [ln for ln in txt.splitlines() if ln.startswith("next:")]
        cs = re.search(r"client scrub: ([a-z0-9 ]+)", txt)
        ss = re.search(r"server scrub: (\d+) redaction", txt)
        ok = res[0] == 0
        return ok, ([f"saved {os.path.basename(f)[:8]}… as «{label}», {UPLOAD_MODES[upload_mode()][1].split(' (')[0]} (setting `upload`)"
                     + (f" ({st.group(1)})" if st else "")
                     + (f"; on this computer: {cs.group(1).strip()}" if cs else "")
                     + (f"; on the server: {ss.group(1)} redaction(s)" if ss else "")]
                    + ([f"{DIM}note: today the copy that comes back from the library is redacted in any case (names, home paths){RS}"]
                       if flag else []) + nxt if ok else lines_of(res)[-6:])

    # ------------------------------------------------------------ operations
    def cell_ops(self, r):
        d, mesh, me = self.d, self.d.ref, self.d.mine.get("name") or ""
        ops = []
        if r["here"]:
            if r["running"] and r["pane"]:
                ops += [("g", "go to its pane", lambda: run([HERDR, "agent", "focus", r["pane"]])[0] and self.note(["herdr could not go there"])),
                        ("p", "send it a prompt", lambda: self.ask(f"prompt for {r['name']}", lambda t: self.bg(
                            f"prompt to {r['name']}", lambda: ["sent; its pane shows the answer (g)"] if run(
                                [HERDR, "agent", "prompt", r["pane"], t])[0] == 0 else ["herdr could not send it"])))]
            if r["running"]:
                ops += [("b", f"back up its conversation ({UPLOAD_MODES[upload_mode()][1].split(' (')[0]}; setting `upload`)", lambda: self.with_scrub(f"backup of {r['name']}", lambda fl: self.bg(
                            f"backup of {r['name']}", lambda: self.push(r, f"{r['name']}-backup", f"{r['name']}: backups from the deck", fl)[1]))),
                        ("x", "stop it here", lambda: self.choose(f"stop {r['name']} on this host?", ["no", "yes, stop it"],
                         lambda i: i == 1 and self.bg(f"stop {r['name']}", lambda: lines_of(run([*A4SX_ARGV, "mesh", "cell", "stop", r["name"]])))))]
                if not r["pane"] and IN_HERDR:
                    ops += [("i", "move it into herdr (it runs outside)", lambda: self.move_here(r))]
            else:
                ops += [("s", "start it here, same conversation", lambda: self.start_cell(r["name"], [*A4SX_ARGV, "launch", "--cell", r["name"]], r.get("iid"))),
                        ("n", "start it with a new conversation", lambda: self.start_cell(r["name"], [*A4SX_ARGV, "launch", "--cell", r["name"], "--new-session"], r.get("iid")))]
            ops += [("r", "restore from a saved state …", lambda: self.restore(r)),
                    ("f", "launch profile (model route) …", lambda: self.set_profile(r)),
                    ("l", "Claude sign-in of this host: on/off …", lambda: self.choose(
                        f"{r['name']}: run Claude Code on this host's own sign-in?", ["on", "off"], lambda i: self.bg(
                            f"local sign-in {('on', 'off')[i]} for {r['name']}", lambda: lines_of(
                                run([*A4SX_ARGV, "mesh", "cell", "local-login", r["name"], ("on", "off")[i]]))))),
                    ("d", "make it the default cell", lambda: self.bg(f"default cell {r['name']}", lambda: lines_of(
                        run([*A4SX_ARGV, "mesh", "cell", "default", r["name"]]), "done"))),
                    ("e", "rename …", lambda: self.ask(f"new name for {r['name']}", lambda t: self.note(
                        [new_tab("rename", os.path.expanduser("~"), [*A4SX_ARGV, "mesh", "cell", "rename", r["name"], t])])))]
        else:
            has = any(x["name"] == f"handoff-{r['name']}" for x in d.library)
            if r.get("mine"):
                ops += [("s", "bring it here (starts it on this host)", lambda: self.bring(r["name"], False))]
        if r.get("running"):   # 0.4.6 (cell01): a cell of this host: its own deliveries, not «me ↔ me»
            ops += [("m", "its last messages", lambda: self.note(own_messages(d, r["name"]), f"{r['name']}: last messages"))]
        else:
            ops += [("m", "last messages with your cell", lambda: self.bg(f"{me} ↔ {r['name']}", lambda: [
                x.strip() for x in lines_of(run([*A4SX_ARGV, "mesh", "deliveries", r["name"], "--mesh", mesh, "--last", "8"]),
                                            "no messages recorded here with this cell")]))]
        if r["name"] != me:
            ops += [("w", "why can/can't you message it", lambda: self.bg(f"{me} → {r['name']}", lambda: lines_of(
                        run([*A4SX_ARGV, "mesh", "policy", mesh, "--explain", me, r["name"]])))),
                    ("t", "traffic rule for a pair …", lambda: self.traffic(r))]
        return ops

    def lib_ops(self, x):
        here = [r for r in self.d.rows if r["here"]]
        name = x["name"]
        return [("r", "resume natively (plain session)", lambda: self.ask(
                    f"folder to start in [~/projects/{name}]", lambda t: self.note([new_tab(
                        name[:18], os.path.expanduser(t) if t else self.pdir(name), [*A4SX_ARGV, "launch", "--a4sx-session", name])]), True)),
                ("c", "resume as a cell of this host …", lambda: self.takeover(name)),
                ("f", "download its transcript", lambda: self.bg(f"fetch {name}", lambda: lines_of(run([*A4SX_ARGV, "fetch", name], 180)))),
                ("z", "size against the model window", lambda: self.bg(f"size of {name}", lambda: lines_of(run([*A4SX_ARGV, "tokens", name], 180)))),
                ("u", "publish (on the site)", lambda: self.note(["publishing is your step on the site: https://session-exchange.com/sell",
                                                                  "new draft from this saved session → preview → publish; the deck publishes nothing"])),
                ("X", "delete from the library …", lambda: self.choose(f"PERMANENTLY delete «{name}» with all versions?", ["no", "yes, delete"],
                 lambda i: i == 1 and self.note([new_tab("delete", os.path.expanduser("~"), [*A4SX_ARGV, "delete", name])])))] if here or True else []

    def restore(self, r):
        """0.4.6 (q), cell01: newest first, and this cell's own saves (`<cell>-…`, `handoff-<cell>`) marked."""
        if not r.get("running") and runs_elsewhere(r):   # 0.4.7 (cell01): said before the picker, not after it
            return self.note(self.elsewhere_lines(r["name"], "started here from a saved conversation", "start it here"), r["name"])
        lib = restore_order(self.d.library, r["name"])
        if not lib:
            return self.note(["your library is empty, or this host is not signed in (a4sx login)"])
        self.choose(f"start {r['name']} from which saved conversation? (a new local session seeded from it)",
                    [f"{(f'{CYAN}◆{RS} ' if of_cell(x['name'], r['name']) else '  ')}{x['name']:<34}{DIM}{x['updated']}  v{x['vers']}  {x['size']}{RS}"
                     for x in lib],
                    lambda i: self.start_seeded(r, lib[i]["name"]))

    def start_seeded(self, r, saved):
        pending = self.__dict__.setdefault("starting", set())
        if r["name"] in pending:   # review: a second Enter while the first start is checked starts nothing more
            return
        pending.add(r["name"])

        def work():
            try:
                return seeded()
            finally:
                pending.discard(r["name"])

        def seeded():
            if not r["running"]:   # cell01: it may have started since the last refresh (herdr restores cells)
                now = self.running_now(r["name"], r.get("iid"))
                if now is not None:
                    return [f"«{r['name']}» is already running on this host" + (f", in pane {now}: g goes there" if now else "")
                            + "; nothing was started"]
                if self.still_elsewhere(r["name"]):   # 0.4.6: as s and n (F6): nothing is started here
                    return self.elsewhere_lines(r["name"], "started here from a saved conversation", "start it here")
            ok_name = CELL_NAME_RE.fullmatch(str(r["name"]))
            # 0.4.8 (cell01): a running cell's own tab, the pane its launch runs in (by its process), and that tab's
            # folder come first: the CLI's record is only for a cell that doesn't run (it isn't written on every start)
            own = None
            if r["running"] and ok_name:
                pane = self.running_now(r["name"], r.get("iid"))
                # review (0.4.10): only a pane found by the launch's own process is the cell's tab; a folder-name
                # match can be the person's own Claude Code pane, which is never stopped into or typed into unasked
                if pane and (self.__dict__.get("run_by") or {}).get(r["name"]) == "pid":
                    tab = next((p.get("tab_id") for p in (jrun([HERDR, "pane", "list"], 8).get("result") or {}).get("panes") or []
                                if p.get("pane_id") == pane), None)
                    own = (pane, tab) if tab else None
            run_cwd = (self.__dict__.get("run_cwd") or {}).get(r["name"]) if own else None
            # 0.4.7 (cell01): the folder its last session ran in (the CLI's record), not always ~/projects/<cell>
            cwd = ((run_cwd if isinstance(run_cwd, str) and os.path.isdir(run_cwd) else None)
                   or (recorded_cwd(r["name"], r.get("iid")) if ok_name else None) or self.pdir(r["name"]))
            argv = [*A4SX_ARGV, "launch", "--cell", r["name"], "--a4sx-session", saved]

            def finish(use_there=None, asked=False):
                res = []
                # 0.4.7 (cell01): a stop only for a cell that runs here now (a stale row gave "nothing was stopped")
                if r["running"] and self.running_now(r["name"], r.get("iid")) is not None:
                    res += lines_of(run([*A4SX_ARGV, "mesh", "cell", "stop", r["name"]]))[-1:]
                    time.sleep(2)
                # 0.4.6 (q): its old tab from before a herdr restart, when it shows a bare shell prompt, not one more tab
                # (review: not after a question: the answer decides, "no" is a new tab)
                if own:   # 0.4.8: its own tab, a bare prompt once the stop has ended the launch (review: a few seconds)
                    for _ in range(5):
                        if pane_is_idle_shell(own[0]):
                            return res + [new_tab(r["name"], cwd, argv, cell=r["name"], reuse=own, own=True)]
                        time.sleep(1)
                old = _leftover_pane(r["name"]) if ok_name and not asked and not own else None
                if old and pane_is_idle_shell(old[0]):
                    return res + [new_tab(r["name"], cwd, argv, cell=r["name"], reuse=old)]
                return res + [new_tab(r["name"], cwd, argv, cell=r["name"], reuse=use_there)]

            # 0.4.7: without the deck's record, an idle shell in that folder. It may be the person's own (their tab,
            # their exported variables): asked, never taken by itself, and asked BEFORE anything is stopped, so Esc
            # (or no answer) leaves a running cell running
            # review: the deck's own record first: its idle pane is reused with no question, as in 0.4.6
            if own:   # 0.4.8: the running cell's own tab: no question about other shells
                return finish()
            rec = _leftover_pane(r["name"]) if ok_name else None
            if rec and pane_is_idle_shell(rec[0]):
                return finish()
            there = _pane_in_folder(cwd, deck_state()[1], rec[0] if rec else None) if ok_name else None
            if there:
                self.msg = ""
                self.choose(f"a shell prompt is open in {cwd} (pane {there[0]}). Start «{r['name']}» in it? It keeps "
                            "that shell's environment; the start command is typed into it"
                            + (" (the cell is stopped first)" if r["running"] else ""),
                            ["no, open a new tab", "yes, start it in that shell"],
                            lambda i: self.bg(f"{r['name']} ← «{saved}»", lambda: finish(there if i == 1 else None, asked=True)))
                return None
            return finish()
        self.bg(f"{r['name']} ← «{saved}»", work)

    def takeover(self, saved):
        here = [r for r in self.d.rows if r["here"]]
        if not here:
            return self.note(["no cell is stored on this host: redeem a cell code first (a4sx launch --cell -)"])
        want = saved[len("handoff-"):] if saved.startswith("handoff-") else ""
        named = [r for r in here if r["name"] == want]
        if named and not named[0]["running"]:   # cell01: a hand-off named after a stopped cell here goes to it, no question
            return self.start_seeded(named[0], saved)
        if named:   # review: a running one is stopped first, so that is asked (as x and S ask)
            return self.choose(f"«{want}» runs here: stop it and start it from «{saved}»?", ["no", "yes, stop it and continue"],
                               lambda i: i == 1 and self.start_seeded(named[0], saved))
        here.sort(key=lambda r: r["name"] != want)
        self.choose(f"which cell of this host continues «{saved}»?",
                    [r["name"] + (f"  {DIM}running: it is stopped first{RS}" if r["running"] else "") for r in here],
                    lambda i: self.start_seeded(here[i], saved))

    def move_here(self, r):
        def work():
            res = lines_of(run([*A4SX_ARGV, "mesh", "cell", "stop", r["name"]]))[-1:]
            time.sleep(2)
            return res + [new_tab(r["name"], self.pdir(r["name"]), [*A4SX_ARGV, "launch", "--cell", r["name"]], cell=r["name"])]
        self.bg(f"move {r['name']} into herdr", work)

    def set_profile(self, r):
        prof = [m.group(1) for ln in run([*A4SX_ARGV, "profiles"])[1].splitlines()[1:] for m in [re.match(r"^\s*(?:★\s+)?(\S+)", ln)] if m]
        prof += ["(clear: follow your default profile)"]
        self.choose(f"launch profile for {r['name']}", prof, lambda i: self.bg(f"profile of {r['name']}", lambda: lines_of(
            run([*A4SX_ARGV, "mesh", "cell", "profile", r["name"]] + (["--clear"] if i == len(prof) - 1 else [prof[i]])), "done")))

    def traffic(self, r):
        others = [x for x in self.d.rows if x["name"] != r["name"]]
        kinds = [("--both", "both ways"), ("--one-way", f"one way: {r['name']} may start, the other may answer"),
                 ("--none", "no traffic between them"), ("--default", "as the mesh's rule says")]

        def second(i):
            o = others[i]
            self.choose(f"{r['name']} ↔ {o['name']}", [k[1] for k in kinds], lambda j: self.note([new_tab(
                "traffic", os.path.expanduser("~"), [*A4SX_ARGV, "mesh", "permit", self.d.ref, r["name"], o["name"], kinds[j][0]]),
                "the owner or an admin confirms it in the browser; for a member the tab shows the refusal and its reason"]))
        self.choose(f"traffic between {r['name']} and …", [o["name"] for o in others], second)

    # ------------------------------------------------------------ drawing
    def where(self, r):
        if r["pane"]:
            return f"{CYAN}◆ here{RS} {DIM}{r['pane']}{RS}"
        if r["here"] and r["name"] in self.d.ah["open"]:
            return f"{CYAN}◆ here{RS} {MAG}VS Code{RS}"
        if r["running"]:
            return f"{CYAN}◆ here{RS} {DIM}{'no pane' if IN_HERDR else 'terminal'}{RS}"
        if runs_elsewhere(r):   # 0.4.6 (r): runs on another host now
            return f"{YEL}● runs elsewhere{RS}"   # 0.4.7 (cell01): fits the 17-wide column; details say "stored here too"
        return f"{CYAN}◇ stored here{RS}" if r["here"] else f"{DIM}elsewhere{RS}"

    def host_lines(self):
        """The agent host of this computer, as the right-hand panel shows it."""
        ah = self.d.ah
        if not ah["known"]:
            return [f"{DIM}agent host: this a4sx has no `agent-host status`{RS}"]
        out = [f"{DIM}agent host{RS} " + (f"{GREEN}● running{RS} {DIM}{ah['address']}{RS}" if ah["running"] else f"{DIM}○ not running{RS}")]
        if ah["running"] and ah.get("answering") is False:
            out.append(f"{RED}it does not answer: stop it (Ctrl-C in its terminal) and start it again{RS}")
        vs = ah.get("vscode") or {}
        eds = vs.get("editors") or {}
        if eds:
            out.append(f"{DIM}VS Code{RS} " + "  ".join((f"{GREEN}✓{RS} " if st == "ok" else f"{YEL}✗{RS} ") + str(ed) + ("" if st == "ok" else f" {DIM}({st}){RS}")
                                                         for ed, st in eds.items()))
        else:
            out.append(f"{DIM}VS Code{RS} {YEL}not set up{RS} {DIM}(V sets it up){RS}")
        out.append(f"{DIM}open in VS Code{RS} " + (", ".join(ah["open"]) if ah["open"] else f"{DIM}no cell{RS}"))
        cl = ah.get("claude") or {}
        if cl:
            out.append(f"{DIM}Claude Code{RS} " + (fit(str(cl.get("path")), 44) if cl.get("path") else f"{RED}not found{RS} {DIM}{cl.get('why') or ''}{RS}"))
        err = ah.get("last_error") or {}
        if err:
            out.append(f"{RED}last error{RS} {DIM}{err.get('at') or ''}{RS}")
            wrapped, line = [], ""
            for w in str(err.get("text") or "").split():   # wrapped to the panel, at most six lines
                if len(line) + len(w) + 1 > 58:
                    wrapped.append(line)
                    line = w
                else:
                    line = (line + " " + w).strip()
            wrapped.append(line)
            if len(wrapped) > 6:
                wrapped = wrapped[:6]
                wrapped[-1] = wrapped[-1][:55] + " …"
            out += ["  " + x for x in wrapped]
        return out

    def host_ops(self):
        ah = self.d.ah
        if not ah["known"]:
            return []
        ops = []
        if not ah["running"]:
            ops.append(("A", "start the agent host (serves VS Code)", lambda: self.note([new_tab("agent host", os.path.expanduser("~"), [*A4SX_ARGV, "agent-host"])])))
        else:   # a4sx #2326 (CLI 0.59.10): the same stop as Ctrl-C in its tab; an older a4sx says so in its own words
            ops.append(("S", "stop the agent host … (as Ctrl-C in its tab: VS Code is told first)", self.stop_host))
        if IN_HERDR:
            ops.append(("L", "close the cells' leftover tabs (bare shell prompts only) …", self.close_leftovers))
        ops.append(("V", "set up VS Code's Agents window", lambda: self.note([new_tab("VS Code setup", os.path.expanduser("~"), [*A4SX_ARGV, "agent-host", "setup-vscode"])])))
        ops.append(("D", "check a4sx's folders (doctor)", lambda: self.bg("doctor", lambda: lines_of(run([*A4SX_ARGV, "doctor"], 120))[-8:])))
        return ops

    def running_now(self, name, iid=None):
        """cell01: the cell's local state read now (the deck's rows can be seconds old, e.g. herdr restored the cell
        meanwhile): None when it isn't running here (or it can't be read now), else the herdr pane its agent runs in
        ("" when unknown). Review: by its instance id when known (the same name in two meshes); not while the server
        says "slow down" (`mesh cells --json` asks it too): the CLI refuses a second start in any case."""
        d = getattr(self, "d", None)
        if d is not None and (LIMITED[0] > getattr(d, "seen_limit", 0) or time.time() < getattr(d, "slow_until", 0)):
            return None
        got = jrun([*A4SX_ARGV, "mesh", "cells", "--json"], 15)
        c = next((c for c in got.get("cells") or [] if (c.get("instance_id") == iid if iid else c.get("name") == name)
                  and (c.get("local") or {}).get("state") == "running"), None)
        if c is None:
            return None
        agents = ((jrun([HERDR, "agent", "list"], 8).get("result") or {}).get("agents") or []) if IN_HERDR else []
        # 0.4.8 (cell01): the pane its launch runs in, by its process, before a folder named like the cell
        pp = pane_of_pid((c.get("local") or {}).get("pid"), agents) if IN_HERDR else None
        a = next((x for x in agents if x.get("pane_id") == pp), None) if pp else None
        # review (0.4.10): how the pane was found: only "pid" is provably the cell's own
        self.__dict__.setdefault("run_by", {})[name] = "pid" if a else None
        if a is None:
            a = next((x for x in agents if os.path.basename((x.get("cwd") or "").rstrip("/")) == name), None)
            self.run_by[name] = "folder" if a else None
        # 0.4.10: where the cell works (a4sx's record or the launch's folder), not the pane's shell folder
        self.__dict__.setdefault("run_cwd", {})[name] = running_cwd(name, iid or c.get("instance_id"), (c.get("local") or {}).get("pid")) or (a or {}).get("cwd")
        return (a or {}).get("pane_id") or ""

    def already_running(self, name, pane):
        return self.note([f"«{name}» is already running on this host" + (f", in pane {pane}: g goes there" if pane else "")
                          + "; nothing was started"], name)

    def leftover_tabs(self):
        """Follow-up (b): the tabs the deck once started cells in that now hold only bare shell prompts (each pane idle by
        process-info) and aren't the deck's own: [(cell, tab)]."""
        mine = deck_state()[1]
        panes = (jrun([HERDR, "pane", "list"], 8).get("result") or {}).get("panes")
        if not isinstance(panes, list):
            return []
        out = []
        for cell, (pane, tab) in list(_cell_panes().items()):
            if not tab or tab == mine:
                continue
            here = [p.get("pane_id") for p in panes if p.get("tab_id") == tab]
            if here and pane in here and all(isinstance(x, str) and pane_is_empty_shell(x) for x in here):
                out.append((cell, tab))
        return out

    def close_leftovers(self):
        """Asks first, naming them; closes only tabs that are still all bare prompts at that moment."""
        def work():
            found = self.leftover_tabs()
            if not found:
                return self.note(["no leftover tabs: every tab of a cell holds something besides a bare shell prompt, or runs a job"],
                                 "leftover tabs")

            def go(i):
                if i != 1:
                    return
                again = {t for _c, t in self.leftover_tabs()}
                done, failed, busy = [], [], []
                for c, t in found:
                    if t not in again:
                        busy.append(c)
                    elif run([HERDR, "tab", "close", t], 8)[0] == 0:
                        done.append(c)
                    else:
                        failed.append(c)
                left = _cell_panes()
                for c in done:
                    left.pop(c, None)
                _save_cell_panes(left)
                lines = [f"closed {len(done)} leftover tab(s)" + (": " + ", ".join(f"«{c}»" for c in done) if done else "")]
                if busy:
                    lines.append("left open (something runs there now): " + ", ".join(f"«{c}»" for c in busy))
                if failed:
                    lines.append("herdr didn't close: " + ", ".join(f"«{c}»" for c in failed))
                self.note(lines, "leftover tabs")
            self.choose(f"close {len(found)} leftover tab(s) of " + ", ".join(f"«{c}»" for c, _t in found)
                        + "? Each holds only an empty shell prompt, with no jobs running", ["no", "yes, close them"], go)
        threading.Thread(target=work, daemon=True).start()

    def start_cell(self, name, argv, iid=None):
        """s / n: a new tab, or (review) the cell's leftover shell from before a herdr restart when the person says it is
        an empty shell: herdr knows whether an agent runs there, not whether vim or ssh does. cell01: never a second
        start of a cell that runs already. Review: the check runs in the background, never in the key handler."""
        pending = self.__dict__.setdefault("starting", set())
        if name in pending:   # review: a second press while the first is checked opens no second tab
            return
        pending.add(name)
        self.msg = f"{name}: checking whether it runs here …"

        def work():
            try:
                now = self.running_now(name, iid)
                if now is not None:
                    return self.already_running(name, now)
                if self.still_elsewhere(name):   # 0.4.5 (F6): its old tab here is not reused either
                    return self.elsewhere_note(name)
                self._start_cell(name, argv)
            finally:
                pending.discard(name)
                if self.msg.startswith(f"{name}: checking"):
                    self.msg = ""
        threading.Thread(target=work, daemon=True).start()

    def _start_cell(self, name, argv):
        old = _leftover_pane(name) if CELL_NAME_RE.fullmatch(str(name)) else None
        if not old:
            return self.note([new_tab(name, self.pdir(name), argv, cell=name)])
        if pane_is_idle_shell(old[0]):   # cell01: herdr shows a bare shell prompt there: no question
            return self.note([new_tab(name, self.pdir(name), argv, cell=name, reuse=old)])
        self.choose(f"«{name}» has its tab from before herdr restarted. Is its pane an empty shell prompt (no vim, ssh, "
                    "…)? The start command is typed into it", ["no, open a new tab", "yes, start it in that pane"],
                    lambda i: self.note([new_tab(name, self.pdir(name), argv, cell=name, reuse=old if i == 1 else None)]))

    def stop_host(self):
        """Review: it ends the cells the host started, so it asks first when some run (as x does for one cell)."""
        def go(i):
            if i != 1:
                return
            def work():
                rc, out, err = run([*A4SX_ARGV, "agent-host", "stop"], 45)
                lines = lines_of((rc, out, err))[-4:]
                if rc and err.startswith("TimeoutExpired"):   # the deck's own timeout (run says so): the host has the request
                    lines = ["no answer within 45 s: if it got as far as asking, the agent host may still stop;",
                             "this view shows when it has, and Ctrl-C in its tab stops it at once"]
                return lines
            self.bg("stop the agent host", work)
        # coordinator: an a4sx before 0.59.10 has no `agent-host stop`: asked without side effects (its --help), and
        # then nothing is asked or stopped, only said
        rc, _out, err = run([*A4SX_ARGV, "agent-host", "stop", "--help"], 20)
        if rc:
            return self.note([STOP_NEEDS_UPDATE] if "invalid choice" in err else lines_of((rc, _out, err))[-4:],
                             "stop the agent host")
        # review: what runs in it now (a fresh status, not the last refresh); plain conversations end too
        now = jrun([*A4SX_ARGV, "agent-host", "status", "--json"], 20) or self.d.ah
        opened = [str(x) for x in now.get("open") or []]
        names = [x.rsplit(" (", 1)[0] for x in opened if not x.endswith(" (plain)")]
        plain = sum(1 for x in opened if x.endswith(" (plain)"))
        what = [f"«{n}»" for n in names] + ([f"{plain} plain conversation" + ("s" if plain > 1 else "")] if plain else [])
        if not what:   # coordinator (as the VS Code extension): nothing runs in it, so no question
            return go(1)
        one = len(what) == 1 and not (not names and plain > 1)
        self.choose(f"stop the agent host? {', '.join(what)} {'ends' if one else 'end'} (VS Code is told first)",
                    ["no", "yes, stop it"], go)

    def first_cell_due(self):
        """a4sx #2309 (bb), cell01: on a fresh host (the mesh data read, no cell stored here, none listed) the deck
        showed MESH "—", PEOPLE 0, CELLS 0 and no next step."""
        d = getattr(self, "d", None)
        if d is None:
            return False
        with d.lock:   # review: _refresh sets `at` and the lists in one locked block; never a half-written read
            return bool(d.at and not d.cells and not d.rows)

    def first_cell(self):
        self.ask("a name for its project folder (~/projects/<name>), like the cell's", lambda t: self.note(
            [new_tab(t, self.pdir(t), [*A4SX_ARGV, "launch", "--cell"])] if CELL_NAME_RE.fullmatch(t)
            else [f"«{ANSI.sub('', t)[:64]}» isn't a folder name the deck takes here (a-z, 0-9 and -), so nothing was "
                  "started"]))

    def online_elsewhere(self, name):
        """a4sx #2309 F6 (cell01): the row of your cell «name» when the deck last saw it online and it doesn't run on
        this host, so it runs on another one, else None. 0.4.5 (cell01's recheck): also when it is stored here too, as
        every cell is after one round trip. Bringing or starting such a cell here fails (the CLI refuses while it runs
        there), so nothing is created, opened or typed first."""
        d = getattr(self, "d", None)
        if d is None:
            return None
        with d.lock:
            rows = list(d.rows)
        return next((r for r in rows if r.get("name") == name and r.get("mine") and not r.get("running")
                     and r.get("presence") == "online"), None)

    def still_elsewhere(self, name):
        """0.4.5 review: the deck's presence is up to a minute old (`mesh peers` every T_SERVER). A cell it saw online and
        not running here is refused only after a fresh `mesh peers` read still says so; a read that can't be made now
        (slowed down, an error) refuses nothing, and the CLI decides in the tab as before. Runs in the background."""
        r = self.online_elsewhere(name)
        if r is None:
            return False
        d = self.d
        if LIMITED[0] > getattr(d, "seen_limit", 0) or time.time() < getattr(d, "slow_until", 0) or not d.ref:
            return False
        got = jrun([*A4SX_ARGV, "mesh", "peers", d.ref, "--json"], 15)
        if "peers" not in got:
            return False
        iid = r.get("iid")
        return any((p.get("instance_id") == iid if iid else p.get("name") == name) and p.get("presence") == "online"
                   for p in got.get("peers") or [])

    def elsewhere_lines(self, name, cant="brought here", then="bring it here"):
        return [f"«{name}» is online on another host now, so it can't be {cant} yet: stop it there "
                f"first (on that host's deck: x stops it), then {then}",
                f"{DIM}nothing was created or started; . reads the mesh again{RS}"]

    def elsewhere_note(self, name):
        self.note(self.elsewhere_lines(name), name)

    def bring(self, name, with_handoff):
        """Start a cell that is stored on another computer here: with the person's sign-in the server moves it. F6: a
        cell online elsewhere is said first (checked fresh, in the background) and nothing is created."""
        argv = [*A4SX_ARGV, "launch", "--cell", name] + (["--a4sx-session", f"handoff-{name}"] if with_handoff else [])

        pending = self.__dict__.setdefault("starting", set())
        if name in pending:   # review: a second press while the first is checked opens no second tab
            return
        pending.add(name)
        self.msg = f"{name}: checking where it runs …"

        def work():
            try:
                now = self.running_now(name)
                if now is not None:
                    return self.already_running(name, now)
                if self.still_elsewhere(name):
                    return self.elsewhere_note(name)
                self.note([new_tab(name, self.pdir(name), argv, cell=name),
                           "the tab shows the outcome: the cell moves here when it is yours, you are signed in here and it is stopped there",
                           f"{DIM}running there? stop it there first (deck: x stops it){RS}"])
            finally:
                pending.discard(name)
                if self.msg.startswith(f"{name}: checking"):
                    self.msg = ""
        threading.Thread(target=work, daemon=True).start()

    def state_cell(self, r, tick):
        if r["state"] == "working":
            return f"{YEL}{SPIN[tick % len(SPIN)]} working{RS}"
        if r["state"] == "blocked":
            return f"{RED}● needs you{RS}"
        if r["state"] in ("idle", "done"):
            return f"{GREEN}● {r['state']}{RS}"
        if r["running"]:
            return f"{GREEN}● running{RS}"
        return f"{GREEN}● online{RS}" if r["presence"] == "online" else f"{DIM}○ offline{RS}"

    def draw(self):
        W, H = shutil.get_terminal_size((160, 48))
        W -= 1
        self.narrow = W < DECK_MIN_W or H < DECK_MIN_H
        if self.narrow:   # cell01: a narrow pane broke the layout; say so instead
            sys.stdout.write("\033[H" + "\n".join(x[:max(W, 1)] + "\033[K" for x in narrow_screen(W + 1, H)[: max(H - 1, 1)]) + "\033[J")
            sys.stdout.flush()
            return
        d, tick = self.d, int(time.time() * 8)
        with d.lock:
            rows, members, mine, lib, reqs = list(d.rows), list(d.members), dict(d.mine), list(d.library), list(d.requests)
        o = []
        tabs = " ".join(f"{PILL}{B} {i + 1} {v} {RS}" if v == self.view else f"{DIM} {i + 1} {v} {RS}" for i, v in enumerate(VIEWS))
        right = f"{DIM}{HOST} · {SPIN[tick % 10] + ' working' if self.busy else 'mesh data ' + (d.at or '…')}{RS}"
        left = f" {MAG}{B}◆ a4sx deck{RS} {FAINT}0.6{RS}   {tabs}"
        o.append(left + " " * max(1, W - vlen(left) - vlen(right) - 1) + right)
        online, here = sum(1 for r in rows if r["presence"] == "online"), sum(1 for r in rows if r["running"])
        pol = mine.get("policy") or {}
        cards = [("MESH", f"{FG}{B}{d.mesh or '—'}{RS}", BLUE), ("PEOPLE", f"{FG}{B}{len(members)}{RS}", MAG),
                 ("CELLS", f"{FG}{B}{len(rows)}{RS}  {GREEN}{online} online{RS}", GREEN),
                 ("HERE", f"{CYAN}{B}{here}{RS} running {DIM}· {sum(1 for r in rows if r['here'])} stored{RS}", CYAN),
                 ("TRAFFIC", f"{FG}{B}{mine.get('mesh_policy') or '?'}{RS} {DIM}rev {pol.get('policy_rev', '?')}{RS}", ORANGE),
                 ("YOU", f"{FG}{B}{mine.get('name') or '—'}{RS} {DIM}{d.role or ''}{RS}", YEL)]
        if d.ah["known"]:   # the VS Code side of this host: its agent host and the cells open in the Agents window
            cards.insert(4, ("VS CODE", (f"{GREEN}● host on{RS} {DIM}· {len(d.ah['open'])} open{RS}" if d.ah["running"]
                                         else f"{DIM}○ agent host off{RS}"), MAG))
        cw = max(16, (W - len(cards) + 1) // len(cards))
        strip = None
        for t, v, c in cards:
            b = box(t, [v], cw, 3, c)
            strip = b if strip is None else side(strip, b, 0)
        o += strip
        need = [f"{RED}● {r['name']} needs you{RS} {DIM}(pane {r['pane']}){RS}" for r in rows if r["state"] == "blocked"]
        need += [f"{YEL}● {c.get('name')} waits for an admin{RS}" for c in d.cells
                 if c.get("needs_approval") and (c.get("registry") or {}).get("state") not in ("active", None)]
        need += [f"{YEL}● join request: {q.get('display_name') or '?'}{RS}" for q in reqs]
        ppl = "   ".join(f"{MAG}●{RS} {FG}{m.get('display_name') or '?'}{RS} {DIM}{m.get('role') or ''} · {len(m.get('instances') or [])}{RS}" for m in members)
        o.append(fit(f" {B}needs you{RS}  " + ("   ".join(need) if need else f"{DIM}nothing{RS}") + f"     {DIM}people{RS}  {ppl}", W))
        its = self.items()
        sel = self.keep_sel(its)
        out_h = (min(len(self.out), 11) + 2) if self.out else 0
        ov_h = (min(len(self.pick), 12) + 3) if self.mode == "pick" else (3 if self.mode == "input" else 0)
        main_h = max(8, H - len(o) - out_h - ov_h - 3)
        lw = max(60, int(W * 0.60))
        rw = W - lw - 1
        vis = main_h - 3
        start = max(0, min(sel - vis // 2, max(0, len(its) - vis)))

        def mark(k):
            return f"{CYAN}▌{RS}" if k == sel else " "

        def hl(k, s):
            return f"{SELBG}{fit(s, lw - 4)}{RS}" if k == sel and self.mode == "browse" else s
        L, cur = [], self.cur()
        if self.view in ("mesh", "rules", "host"):
            L.append(f"{DIM}  {'cell':<26}{'of':<26}{'where':<18}now{RS}")
            for k, r in enumerate(its[start:start + vis], start):
                where = self.where(r)
                own = r["owner"] + (f" {r['role'][:1]}" if r["role"] else "")
                L.append(hl(k, f"{mark(k)} {FG}{B if r['here'] else ''}{fit(r['name'] or '?', 25)}{RS} {DIM}{fit(own, 25)}{RS} {fit(where, 17)} {self.state_cell(r, tick)}"))
            title = {"mesh": "CELLS", "rules": "CELLS · traffic", "host": "CELLS ON THIS HOST"}[self.view]
            self.ops = self.cell_ops(cur) if cur else []
            if self.view != "rules" and self.first_cell_due():   # a4sx #2309 (bb): a fresh host's one next step
                L += FIRST_CELL_LINES
                self.ops = [("f", "start your first cell here …", self.first_cell)]
            if self.view == "rules":
                self.ops = [("v", "who can message whom", lambda: self.bg("who can message whom", lambda: [x.strip() for x in lines_of(
                    run([*A4SX_ARGV, "mesh", "policy", self.d.ref, "--show-matrix"], 60))]))] + [x for x in self.ops if x[0] in ("w", "t", "m")]
            Rt = []
            if cur:
                Rt = [f"{FG}{B}{cur['name']}{RS}  {self.state_cell(cur, tick)}", f"{DIM}of{RS} {cur['owner']} {DIM}{cur['role']}{RS}"]
                if cur["here"] and runs_elsewhere(cur):   # 0.4.6 (r): not "on <this host>" while it runs elsewhere
                    Rt += [f"{DIM}on another host now; stored on{RS} {HOST} {DIM}too{RS}", ""]
                elif cur["here"]:
                    Rt += [f"{DIM}on{RS} {HOST}" + (f" {DIM}· pane{RS} {cur['pane']}" if cur["pane"] else ""),
                           f"{DIM}in{RS} {cur['cwd'] or self.pdir(cur['name'])}",
                           f"{DIM}profile{RS} {cur['cell'].get('profile') or '—'}  {DIM}reach{RS} {pol.get('can_talk_to') if pol.get('can_talk_to') is not None else '?'} cells"]
                else:
                    Rt += [f"{DIM}on another host{RS}", ""]
            rt_title = "CELL"
        elif self.view == "library":
            L.append(f"{DIM}  {'saved conversation':<40}{'updated':<18}{'ver':<5}{'size':<7}title{RS}")
            for k, x in enumerate(its[start:start + vis], start):
                nm = ("└ " if x["child"] else "") + x["name"]
                col = ORANGE if x["name"].startswith("handoff-") else FG
                L.append(hl(k, f"{mark(k)} {col}{fit(nm, 39)}{RS} {DIM}{x['updated']}  {fit('v' + x['vers'], 4)} {fit(x['size'], 6)}{RS} {fit(x['title'], max(8, lw - 82))}"))
            if not its:
                L.append(f"{DIM}  nothing saved yet, or this host is not signed in (a4sx login){RS}")
            title, rt_title = "LIBRARY", "SAVED CONVERSATION"
            self.ops = self.lib_ops(cur) if cur else []
            Rt = [f"{FG}{B}{cur['name']}{RS}", f"{DIM}{cur['title']}{RS}", f"{DIM}updated{RS} {cur['updated']}  {DIM}versions{RS} {cur['vers']}  {DIM}size{RS} {cur['size'] or '?'}"] if cur else []
        else:   # move
            hand = [x for x in its if x["kind"] == "handoff"]
            # a4sx #2309: no scrubbed hand-off (it would change the moved cell's peer names) until #2292's as-is copy
            L += [f"{DIM}  a cell moves by starting it on the other host, signed in: same cell, same rules.{RS}",
                  f"{DIM}  its conversation follows once a4sx #2292 lands; until then it starts there with a new one.{RS}",
                  f"   {CYAN}{B}{fit(HOST, 14)}{RS} {FAINT}━━{RS} {ORANGE}s bring here{RS} {FAINT}━▶{RS} {CYAN}{B}the other host{RS}",
                  "", f"{DIM}  cells on this host{RS}"]
            base = len(L)
            for k, x in enumerate(its):
                if x["kind"] == "handoff" and (k == 0 or its[k - 1]["kind"] != "handoff"):
                    L += ["", f"{DIM}  saved conversations named handoff-… (start one here){RS}"]
                if x["kind"] == "away" and (k == 0 or its[k - 1]["kind"] != "away"):
                    L += ["", f"{DIM}  cells of {x['owner']} on other hosts{RS}"]
                if x["kind"] == "cell":
                    L.append(hl(k, f"{mark(k)} {FG}{B}{fit(x['name'], 26)}{RS} {self.state_cell(x, tick)}  {DIM}{x['cwd'] or ''}{RS}"))
                elif x["kind"] == "away":
                    L.append(hl(k, f"{mark(k)} {FG}{fit(x['name'], 26)}{RS} {self.state_cell(x, tick)}"))
                else:
                    L.append(hl(k, f"{mark(k)} {ORANGE}{fit(x['name'], 34)}{RS} {DIM}{x['updated']}  v{x['vers']}  {x['size']}{RS}  {fit(x['title'], max(8, lw - 78))}"))
            del base
            title, rt_title = "MOVE", "MOVE"
            if cur and cur["kind"] == "cell":
                self.ops = [x for x in self.cell_ops(cur) if x[0] in ("b", "g", "s", "x")]
                Rt = [f"{FG}{B}{cur['name']}{RS}  {self.state_cell(cur, tick)}", f"{DIM}to move it: bring it here on the other host{RS}",
                      f"{DIM}(its conversation follows once a4sx #2292 lands){RS}"]
            elif cur and cur["kind"] == "away":
                self.ops = [x for x in self.cell_ops(cur) if x[0] == "s"]
                Rt = [f"{FG}{B}{cur['name']}{RS}  {self.state_cell(cur, tick)}", f"{DIM}on another host. Starting it here moves it:{RS}",
                      f"{DIM}the other host's key stops working.{RS}"]
            elif cur:
                self.ops = [("a", "start from a saved session: a cell here, seeded from it", lambda: self.takeover(cur["name"])),
                            ("r", "resume natively (plain session)", self.lib_ops(cur)[0][2]), ("X", "delete this saved conversation …", self.lib_ops(cur)[5][2])]
                Rt = [f"{ORANGE}{B}{cur['name']}{RS}", f"{DIM}{cur['title']}{RS}", f"{DIM}saved{RS} {cur['updated']}  {DIM}size{RS} {cur['size'] or '?'}"]
            else:
                self.ops, Rt = [], []
            self.ops = self.ops + [("n", "bring a cell here by its name …", lambda: self.ask(
                "name of your cell to start on this host", lambda t: self.bring(t, False)))]
        if self.view == "host":
            self.ops = self.host_ops() + self.ops
            Rt = self.host_lines() + ([""] + Rt if Rt else [])
            rt_title = "THIS HOST"
        Rt += ["", f"{DIM}operations{RS}"] + [f"{CYAN}{B}{k}{RS}  {lbl}" for k, lbl, _ in self.ops]
        if self.view == "mesh":
            # the first screen says how to use the deck and herdr: the keys, at the foot of the right panel when they fit
            K = [f"{DIM}keys of this deck{RS}",
                 f"{CYAN}{B}{fit('1-5', 12)}{RS} views: mesh, library, rules, host, move",
                 f"{CYAN}{B}{fit('↑ ↓', 12)}{RS} choose a row; a letter runs its operation",
                 f"{CYAN}{B}{fit('.  ?  q', 12)}{RS} refresh · what is missing · close"]
            if self.herdr_keys:
                K += ["", f"{DIM}keys of herdr (from your config){RS}"] + [f"{CYAN}{B}{fit(k, 12)}{RS} {what}" for k, what in self.herdr_keys]
                K += [f"{DIM}closed the deck? herdr's actions: «a4sx deck: open …»{RS}"]
            room = (main_h - 2) - len(Rt)
            if room >= len(K) + 1:
                Rt += [""] * (room - len(K)) + K
        left_box = box(title, L, lw, main_h, BLUE, f"{sel + 1}/{len(its)}" if its else "")
        if self.view == "mesh" and main_h - (len(L) + 3) >= 6:
            top_h = len(L) + 3
            with d.lock:
                acts = list(d.activity)
            A = []
            for at, way, cell, peer, status in acts[: main_h - top_h - 2]:
                arrow = f"{CYAN}◀── from{RS}" if way == "in" else f"{ORANGE}──▶ to  {RS}"
                what = {"inbox": "in the inbox", "sent": "sent, waiting for the confirmation", "delivered": "delivered", "held": f"{YEL}held for you{RS}"}.get(status, status)
                A.append(f"{DIM}{time.strftime('%H:%M:%S', time.localtime(at))}{RS}  {FG}{fit(cell or '', 16)}{RS} {arrow} {FG}{fit(peer, 26)}{RS} {DIM}{what}{RS}")
            if not A:
                A = [f"{DIM}no messages recorded on this host yet{RS}" if getattr(d, "activity_read", True)
                     else f"{DIM}reading this host's delivery records …{RS}"]
            left_box = box(title, L, lw, top_h, BLUE, f"{sel + 1}/{len(its)}" if its else "") + box(
                "MESSAGES OF THIS HOST'S CELLS", A, lw, main_h - top_h, GREEN, "newest first")
        o += side(left_box, box(rt_title, Rt, rw, main_h, MAG))
        if self.mode == "pick":
            s0 = max(0, min(self.pick_sel - 5, max(0, len(self.pick) - 12)))
            o += box(self.pick_title, [(f"{SELBG}{CYAN}▌{RS}{SELBG} {fit(it, W - 8)}{RS}" if k == self.pick_sel else f"  {it}")
                                       for k, it in enumerate(self.pick[s0:s0 + 12], s0)], W, min(len(self.pick), 12) + 3, YEL, "↑↓ Enter choose · Esc back")
        elif self.mode == "input":
            o += box(self.inp_title, [f"{FG}{self.inp}{RS}{CYAN}█{RS}"], W, 3, YEL, "Enter ok · Esc back")
        if self.out:
            o += box(self.out_title, self.out[:11], W, min(len(self.out), 11) + 2, GREEN, "c clears")
        keys = f" {DIM}1-5{RS} views  {DIM}↑↓{RS} select  {DIM}letter{RS} operation  {DIM}.{RS} refresh  {DIM}?{RS} what is missing  {DIM}q{RS} close"
        o.append(fit(keys + (f"     {YEL}{self.msg or d.stale}{RS}" if (self.msg or d.stale) else ""), W))
        sys.stdout.write("\033[H" + "\n".join(x + "\033[K" for x in o[: H - 1]) + "\033[J")
        sys.stdout.flush()

    # ------------------------------------------------------------ keys
    def key(self, k):
        if getattr(self, "narrow", False):   # review: unseen operations never run; only closing works there (q, as it says)
            return k not in ("q", "\x03")
        if self.mode == "input":
            if k == "esc":
                self.mode = "browse"
            elif k == "enter":
                cb, t, self.mode = self.inp_cb, self.inp.strip(), "browse"
                if t or self.inp_empty_ok:
                    cb(t)
            elif k == "back":
                self.inp = self.inp[:-1]
            elif k and len(k) == 1 and k.isprintable():
                self.inp += k
            return True
        if self.mode == "pick":
            if k == "esc":
                self.mode = "browse"
            elif k in ("up", "k"):
                self.pick_sel = max(0, self.pick_sel - 1)
            elif k in ("down", "j"):
                self.pick_sel = min(len(self.pick) - 1, self.pick_sel + 1)
            elif k == "enter":
                cb, i, self.mode = self.pick_cb, self.pick_sel, "browse"
                cb(i)
            return True
        n = len(self.items())
        if k in ("q", "\x03"):
            return False
        if k in ("1", "2", "3", "4", "5"):
            was, self.view = self.view, VIEWS[int(k) - 1]
            if self.view == "move" and was != "move":   # cell01: the library as it is now, one call when it opens
                self.reload_library()
        elif k in ("up", "k"):
            self.sel[self.view] = max(0, min(self.sel[self.view], n - 1) - 1)
            self.__dict__.setdefault("sel_key", {}).pop(self.view, None)   # 0.4.8: the person moved: the new row counts
        elif k in ("down", "j"):
            self.sel[self.view] = min(max(0, n - 1), self.sel[self.view] + 1)
            self.__dict__.setdefault("sel_key", {}).pop(self.view, None)
        elif k == ".":
            if time.time() - self.last_dot < 15:
                self.msg = "refreshed a moment ago (the server allows a sign-in about 60 lookups a minute)"
            else:
                self.last_dot = time.time()
                self.bg("refresh", lambda: [])
        elif k == "c":
            self.out = []
        elif k == "?":
            self.note(["what a cell on another host is doing: needs the mesh's activity log as a command",
                       "held messages of a local cell: readable only from inside the cell today (herdr marks the pane)",
                       "stopping a cell that runs on another host from here: you stop it there, then bring it here",
                       "a moved cell's conversation: follows once a4sx #2292 lands (until then it starts there anew)",
                       "which herdr pane a cell runs in: the deck matches by folder name"], "not possible yet")
        else:
            for kk, _, fn in self.ops:
                if k == kk:
                    fn()
                    break
        return True


def read_key(fd, timeout):
    if WIN:
        import msvcrt
        end = time.time() + timeout
        while time.time() < end:
            if msvcrt.kbhit():
                ch = msvcrt.getwch()
                if ch in ("\x00", "\xe0"):   # arrow and function keys come as two codes
                    return {"H": "up", "P": "down"}.get(msvcrt.getwch(), "")
                return {"\r": "enter", "\x1b": "esc", "\x08": "back"}.get(ch, ch)
            time.sleep(0.03)
        return None
    if not select.select([fd], [], [], timeout)[0]:
        return None
    ch = os.read(fd, 16).decode(errors="replace")
    return {"\x1b[A": "up", "\x1b[B": "down", "\r": "enter", "\n": "enter", "\x1b": "esc", "\x7f": "back", "\x08": "back"}.get(ch, ch[:1])


def pane():
    deck = Deck()
    fd = old = None
    if WIN:
        import ctypes
        k32 = ctypes.windll.kernel32
        h, mode = k32.GetStdHandle(-11), ctypes.c_uint()
        if k32.GetConsoleMode(h, ctypes.byref(mode)):
            k32.SetConsoleMode(h, mode.value | 0x0004)   # let the console read the colour and cursor codes
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    else:
        fd = sys.stdin.fileno()
        old = termios.tcgetattr(fd)
    stop = threading.Event()

    def loop():
        while not stop.is_set():
            try:
                deck.d.refresh()
                if deck.msg == "loading…":
                    deck.msg = ""
            except Exception as e:   # noqa: BLE001
                deck.msg = f"refresh failed: {e!r}"
            stop.wait(T_LOCAL)
    threading.Thread(target=loop, daemon=True).start()
    if not WIN:   # review: herdr closing the pane (SIGHUP/SIGTERM) still runs the cleanup below (the marker goes)
        import signal
        for sig in (signal.SIGHUP, signal.SIGTERM):
            signal.signal(sig, lambda *_: sys.exit(0))
    mine = os.environ.get("HERDR_PANE_ID") or ""
    if IN_HERDR and mine:   # so herdr's start and the "open" action find this deck instead of opening a second one
        try:
            os.makedirs(os.path.dirname(_marker()), exist_ok=True)
            tab = next((p.get("tab_id") for p in (jrun([HERDR, "pane", "list"], 8).get("result") or {}).get("panes") or []
                        if p.get("pane_id") == mine), "") or ""
            with open(_marker(), "w", encoding="utf-8") as f:
                f.write(f"{mine} {os.getpid()} {tab}".strip())
        except OSError:
            pass
    try:
        if not WIN:
            tty.setcbreak(fd)
        sys.stdout.write("\033]0;" + DECK_TITLE + "\007\033[?25l\033[2J")
        while True:
            deck.draw()
            k = read_key(fd, 0.25)
            if k is not None and not deck.key(k):
                break
    finally:
        stop.set()
        try:   # review: the marker first: after herdr closed the pane the tty is gone and its restore may raise
            with open(_marker(), encoding="utf-8") as f:
                if mine and f.read().strip().split(" ")[:2] == [mine, str(os.getpid())]:
                    os.remove(_marker())
        except OSError:
            pass
        try:
            if not WIN:
                termios.tcsetattr(fd, termios.TCSADRAIN, old)
            sys.stdout.write("\033[?25h\033[0m\033[2J\033[H")
        except (OSError, termios.error if termios else OSError):
            pass


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "pane"
    if cmd == "open":
        sys.exit(open_deck(True))
    if cmd == "start":
        sys.exit(start())
    if cmd == "label":
        Data().refresh()
        sys.exit(0)
    pane()
