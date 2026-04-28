import { createRequire as e } from "node:module";
import t, {
  BrowserWindow as n,
  Menu as r,
  MessageChannelMain as i,
  Notification as a,
  Tray as o,
  WebContentsView as s,
  app as c,
  clipboard as l,
  dialog as u,
  ipcMain as d,
  nativeImage as f,
  nativeTheme as p,
  net as m,
  session as h,
  shell as g,
  systemPreferences as _,
} from "electron";
import v, {
  basename as y,
  dirname as b,
  normalize as x,
  posix as S,
  relative as C,
  resolve as w,
  sep as T,
} from "path";
import E from "node:crypto";
import { spawn as D } from "node:child_process";
import O, {
  chmod as k,
  copyFile as ee,
  mkdir as A,
  mkdtemp as j,
  readFile as M,
  rm as te,
  writeFile as N,
} from "node:fs/promises";
import P from "node:os";
import F, { existsSync as I } from "node:fs";
import L, {
  delimiter as R,
  dirname as z,
  join as B,
  normalize as V,
  resolve as H,
} from "node:path";
import { getFonts as U } from "font-list";
import * as W from "fs";
import G from "fs";
import { fileURLToPath as ne, pathToFileURL as K } from "url";
import { createRequire as q } from "module";
import J from "better-sqlite3";
import { cwd as Y } from "node:process";
import { PassThrough as re } from "node:stream";
import ie from "node:readline";
import { createServer as ae } from "node:http";
import { pathToFileURL as oe } from "node:url";
var se = Object.create;
var ce = Object.defineProperty;
var le = Object.getOwnPropertyDescriptor;
var ue = Object.getOwnPropertyNames;
var de = Object.getPrototypeOf;
var fe = Object.prototype.hasOwnProperty;
var X = (e, t) => () => {
  if (!t) {
    e(
      (t = {
        exports: {},
      }).exports,
      t,
    );
  }
  return t.exports;
};
var pe = (e, t, n, r) => {
  if ((t && typeof t == `object`) || typeof t == `function`) {
    var i = ue(t);
    for (var a = 0, o = i.length, s; a < o; a++) {
      s = i[a];
      if (!fe.call(e, s) && s !== n) {
        ce(e, s, {
          get: ((e) => t[e]).bind(null, s),
          enumerable: !(r = le(t, s)) || r.enumerable,
        });
      }
    }
  }
  return e;
};
var me = (e, t, n) => {
  n = e == null ? {} : se(de(e));
  return pe(
    t || !e || !e.__esModule
      ? ce(n, `default`, {
          value: e,
          enumerable: true,
        })
      : n,
    e,
  );
};
var he = ((e) =>
  typeof require < `u`
    ? require
    : typeof Proxy < `u`
      ? new Proxy(e, {
          get: (e, t) => (typeof require < `u` ? require : e)[t],
        })
      : e)(function (e) {
  if (typeof require < `u`) {
    return require.apply(this, arguments);
  }
  throw Error(
    'Calling `require` for "' +
      e +
      "\" in an environment that doesn't expose the `require` function.",
  );
});
globalThis.require = e(import.meta.url);
var ge = () => ({
  input() {
    return ge();
  },
  action: (e) => ({
    action: e,
  }),
});
var _e = {
  create() {
    return {
      procedure: ge(),
    };
  },
};
var ve = (e) => {
  for (let [t, n] of Object.entries(e)) {
    d.handle(t, (e, t) =>
      n.action({
        context: {
          sender: e.sender,
        },
        input: t,
      }),
    );
  }
};
var Z = (e) =>
  new Proxy(
    {},
    {
      get: (t, n) => ({
        send: (...t) => e.send(n.toString(), ...t),
        invoke: async (...t) => {
          let r = E.randomUUID();
          return new Promise((i, a) => {
            d.once(r, (e, { error: t, result: n }) => {
              if (t) {
                a(t);
              } else {
                i(n);
              }
            });
            e.send(n.toString(), r, ...t);
          });
        },
      }),
    },
  );
const ye = `electron-exec:request`;
var be = Object.create;
var xe = Object.defineProperty;
var Se = Object.getOwnPropertyDescriptor;
var Ce = Object.getOwnPropertyNames;
var we = Object.getPrototypeOf;
var Te = Object.prototype.hasOwnProperty;
var Ee = (e, t) => () => {
  if (!t) {
    e(
      (t = {
        exports: {},
      }).exports,
      t,
    );
  }
  return t.exports;
};
var De = (e, t, n, r) => {
  if ((t && typeof t == `object`) || typeof t == `function`) {
    var i = Ce(t);
    for (var a = 0, o = i.length, s; a < o; a++) {
      s = i[a];
      if (!Te.call(e, s) && s !== n) {
        xe(e, s, {
          get: ((e) => t[e]).bind(null, s),
          enumerable: !(r = Se(t, s)) || r.enumerable,
        });
      }
    }
  }
  return e;
};
var Oe = (e, t, n) => {
  n = e == null ? {} : be(we(e));
  return De(
    t || !e || !e.__esModule
      ? xe(n, `default`, {
          value: e,
          enumerable: true,
        })
      : n,
    e,
  );
};
var ke = e(import.meta.url);
var Ae = Oe(
  Ee((e, t) => {
    var n = ke(`child_process`);
    var r = n.spawn;
    var i = n.exec;
    t.exports = function (e, t, n) {
      if (typeof t == `function` && n === undefined) {
        n = t;
        t = undefined;
      }
      e = parseInt(e);
      if (Number.isNaN(e)) {
        if (n) {
          return n(Error(`pid must be a number`));
        }
        throw Error(`pid must be a number`);
      }
      var o = {};
      var c = {};
      o[e] = [];
      c[e] = 1;
      switch (process.platform) {
        case `win32`:
          i(`taskkill /pid ${e} /T /F`, n);
          break;
        case `darwin`:
          s(
            e,
            o,
            c,
            function (e) {
              return r(`pgrep`, [`-P`, e]);
            },
            function () {
              a(o, t, n);
            },
          );
          break;
        default:
          s(
            e,
            o,
            c,
            function (e) {
              return r(`ps`, [`-o`, `pid`, `--no-headers`, `--ppid`, e]);
            },
            function () {
              a(o, t, n);
            },
          );
          break;
      }
    };
    function a(e, t, n) {
      var r = {};
      try {
        Object.keys(e).forEach(function (n) {
          e[n].forEach(function (e) {
            if (!r[e]) {
              o(e, t);
              r[e] = 1;
            }
          });
          if (!r[n]) {
            o(n, t);
            r[n] = 1;
          }
        });
      } catch (e) {
        if (n) {
          return n(e);
        }
        throw e;
      }
      if (n) {
        return n();
      }
    }
    function o(e, t) {
      try {
        process.kill(parseInt(e, 10), t);
      } catch (e) {
        if (e.code !== `ESRCH`) {
          throw e;
        }
      }
    }
    function s(e, t, n, r, i) {
      var a = r(e);
      var o = ``;
      a.stdout.on(`data`, function (e) {
        var e = e.toString(`ascii`);
        o += e;
      });
      a.on(`close`, function (a) {
        delete n[e];
        if (a != 0) {
          if (Object.keys(n).length == 0) {
            i();
          }
          return;
        }
        o.match(/\d+/g).forEach(function (a) {
          a = parseInt(a, 10);
          t[e].push(a);
          t[a] = [];
          n[a] = 1;
          s(a, t, n, r, i);
        });
      });
    }
  })(),
  1,
);
const je = new Map();
function Me(e, t) {
  let n = e.pid;
  if (n) {
    return new Promise((e, r) => {
      (0, Ae.default)(n, t, (t) => {
        if (t) {
          return r(t);
        }
        e();
      });
    });
  }
  e.kill(t);
}
function Ne(e) {
  return {
    name: e.name,
    message: e.message,
    stack: e.stack,
    code: e.code,
  };
}
function Pe() {
  let e = (e, t) => {
    if (t.type === `spawn`) {
      let n = D(t.command, t.args, {
        cwd: t.options?.cwd,
        env: t.options?.env,
        shell: t.options?.shell,
        stdio: [`pipe`, `pipe`, `pipe`],
      });
      let r = e.sender;
      let i = r.id;
      let a = (e) => {
        if (!r.isDestroyed()) {
          r.send(`electron-exec:event`, e);
        }
      };
      let o = je.get(i);
      if (!o) {
        o = new Map();
        je.set(i, o);
        r.once(`destroyed`, () => {
          let e = je.get(i);
          if (e) {
            for (let t of e.values()) {
              Me(t);
            }
            je.delete(i);
          }
        });
      }
      o.set(t.id, n);
      a({
        type: `spawn`,
        id: t.id,
        pid: n.pid,
      });
      n.stdout?.on(`data`, (e) => {
        a({
          type: `stdout`,
          id: t.id,
          data: e,
        });
      });
      n.stderr?.on(`data`, (e) => {
        a({
          type: `stderr`,
          id: t.id,
          data: e,
        });
      });
      n.on(`error`, (e) => {
        a({
          type: `error`,
          id: t.id,
          error: Ne(e),
        });
      });
      n.on(`close`, (e, n) => {
        o.delete(t.id);
        if (o.size === 0) {
          je.delete(i);
        }
        a({
          type: `close`,
          id: t.id,
          code: e,
          signal: n,
        });
      });
      return;
    }
    let n = je.get(e.sender.id)?.get(t.id);
    if (n) {
      if (t.type === `kill`) {
        Me(n, t.signal);
        return;
      }
      if (t.type === `stdin:write`) {
        n.stdin?.write(Buffer.from(t.data));
        return;
      }
      n.stdin?.end(t.data ? Buffer.from(t.data) : undefined);
    }
  };
  d.on(ye, e);
  return () => {
    d.removeListener(ye, e);
  };
}
var Fe = q(import.meta.url);
function Ie(e) {
  let t = x(e);
  if (t.length > 1 && t[t.length - 1] === T) {
    t = t.substring(0, t.length - 1);
  }
  return t;
}
const Le = /[\\/]/g;
function Re(e, t) {
  return e.replace(Le, t);
}
const ze = /^[a-z]:[\\/]$/i;
function Be(e) {
  return e === `/` || ze.test(e);
}
function Ve(e, t) {
  let { resolvePaths: n, normalizePath: r, pathSeparator: i } = t;
  let a =
    (process.platform === `win32` && e.includes(`/`)) || e.startsWith(`.`);
  if (n) {
    e = w(e);
  }
  if (r || a) {
    e = Ie(e);
  }
  if (e === `.`) {
    return ``;
  } else {
    return Re(e[e.length - 1] === i ? e : e + i, i);
  }
}
function He(e, t) {
  return t + e;
}
function Ue(e, t) {
  return function (n, r) {
    if (r.startsWith(e)) {
      return r.slice(e.length) + n;
    } else {
      return Re(C(e, r), t.pathSeparator) + t.pathSeparator + n;
    }
  };
}
function We(e) {
  return e;
}
function Ge(e, t, n) {
  return t + e + n;
}
function Ke(e, t) {
  let { relativePaths: n, includeBasePath: r } = t;
  if (n && e) {
    return Ue(e, t);
  } else if (r) {
    return He;
  } else {
    return We;
  }
}
function qe(e) {
  return function (t, n) {
    n.push(t.substring(e.length) || `.`);
  };
}
function Je(e) {
  return function (t, n, r) {
    let i = t.substring(e.length) || `.`;
    if (r.every((e) => e(i, true))) {
      n.push(i);
    }
  };
}
const Ye = (e, t) => {
  t.push(e || `.`);
};
const Xe = (e, t, n) => {
  let r = e || `.`;
  if (n.every((e) => e(r, true))) {
    t.push(r);
  }
};
const Ze = () => {};
function Qe(e, t) {
  let { includeDirs: n, filters: r, relativePaths: i } = t;
  if (n) {
    if (i) {
      if (r && r.length) {
        return Je(e);
      } else {
        return qe(e);
      }
    } else if (r && r.length) {
      return Xe;
    } else {
      return Ye;
    }
  } else {
    return Ze;
  }
}
const $e = (e, t, n, r) => {
  if (r.every((t) => t(e, false))) {
    n.files++;
  }
};
const et = (e, t, n, r) => {
  if (r.every((t) => t(e, false))) {
    t.push(e);
  }
};
const tt = (e, t, n, r) => {
  n.files++;
};
const nt = (e, t) => {
  t.push(e);
};
const rt = () => {};
function it(e) {
  let { excludeFiles: t, filters: n, onlyCounts: r } = e;
  if (t) {
    return rt;
  } else if (n && n.length) {
    if (r) {
      return $e;
    } else {
      return et;
    }
  } else if (r) {
    return tt;
  } else {
    return nt;
  }
}
const at = (e) => e;
const ot = () => [``].slice(0, 0);
function st(e) {
  if (e.group) {
    return ot;
  } else {
    return at;
  }
}
const ct = (e, t, n) => {
  e.push({
    directory: t,
    files: n,
    dir: t,
  });
};
const lt = () => {};
function ut(e) {
  if (e.group) {
    return ct;
  } else {
    return lt;
  }
}
const dt = function (e, t, n) {
  let {
    queue: r,
    fs: i,
    options: { suppressErrors: a },
  } = t;
  r.enqueue();
  i.realpath(e, (o, s) => {
    if (o) {
      return r.dequeue(a ? null : o, t);
    }
    i.stat(s, (i, o) => {
      if (i) {
        return r.dequeue(a ? null : i, t);
      }
      if (o.isDirectory() && mt(e, s, t)) {
        return r.dequeue(null, t);
      }
      n(o, s);
      r.dequeue(null, t);
    });
  });
};
const ft = function (e, t, n) {
  let {
    queue: r,
    fs: i,
    options: { suppressErrors: a },
  } = t;
  r.enqueue();
  try {
    let r = i.realpathSync(e);
    let a = i.statSync(r);
    if (a.isDirectory() && mt(e, r, t)) {
      return;
    }
    n(a, r);
  } catch (e) {
    if (!a) {
      throw e;
    }
  }
};
function pt(e, t) {
  if (!e.resolveSymlinks || e.excludeSymlinks) {
    return null;
  } else if (t) {
    return ft;
  } else {
    return dt;
  }
}
function mt(e, t, n) {
  if (n.options.useRealPaths) {
    return ht(t, n);
  }
  let r = b(e);
  let i = 1;
  while (r !== n.root && i < 2) {
    let e = n.symlinks.get(r);
    if (e && (e === t || e.startsWith(t) || t.startsWith(e))) {
      i++;
    } else {
      r = b(r);
    }
  }
  n.symlinks.set(e, t);
  return i > 1;
}
function ht(e, t) {
  return t.visited.includes(e + t.options.pathSeparator);
}
const gt = (e) => e.counts;
const _t = (e) => e.groups;
const vt = (e) => e.paths;
const yt = (e) => e.paths.slice(0, e.options.maxFiles);
const bt = (e, t, n) => {
  wt(t, n, e.counts, e.options.suppressErrors);
  return null;
};
const xt = (e, t, n) => {
  wt(t, n, e.paths, e.options.suppressErrors);
  return null;
};
const St = (e, t, n) => {
  wt(t, n, e.paths.slice(0, e.options.maxFiles), e.options.suppressErrors);
  return null;
};
const Ct = (e, t, n) => {
  wt(t, n, e.groups, e.options.suppressErrors);
  return null;
};
function wt(e, t, n, r) {
  t(e && !r ? e : null, n);
}
function Tt(e, t) {
  let { onlyCounts: n, group: r, maxFiles: i } = e;
  if (n) {
    if (t) {
      return gt;
    } else {
      return bt;
    }
  } else if (r) {
    if (t) {
      return _t;
    } else {
      return Ct;
    }
  } else if (i) {
    if (t) {
      return yt;
    } else {
      return St;
    }
  } else if (t) {
    return vt;
  } else {
    return xt;
  }
}
const Et = {
  withFileTypes: true,
};
const Dt = (e, t, n, r, i) => {
  e.queue.enqueue();
  if (r < 0) {
    return e.queue.dequeue(null, e);
  }
  let { fs: a } = e;
  e.visited.push(t);
  e.counts.directories++;
  a.readdir(t || `.`, Et, (t, a = []) => {
    i(a, n, r);
    e.queue.dequeue(e.options.suppressErrors ? null : t, e);
  });
};
const Ot = (e, t, n, r, i) => {
  let { fs: a } = e;
  if (r < 0) {
    return;
  }
  e.visited.push(t);
  e.counts.directories++;
  let o = [];
  try {
    o = a.readdirSync(t || `.`, Et);
  } catch (t) {
    if (!e.options.suppressErrors) {
      throw t;
    }
  }
  i(o, n, r);
};
function kt(e) {
  if (e) {
    return Ot;
  } else {
    return Dt;
  }
}
var At = class {
  count = 0;
  constructor(e) {
    this.onQueueEmpty = e;
  }
  enqueue() {
    this.count++;
    return this.count;
  }
  dequeue(e, t) {
    if (this.onQueueEmpty && (--this.count <= 0 || e)) {
      this.onQueueEmpty(e, t);
      if (e) {
        t.controller.abort();
        this.onQueueEmpty = undefined;
      }
    }
  }
};
var jt = class {
  _files = 0;
  _directories = 0;
  set files(e) {
    this._files = e;
  }
  get files() {
    return this._files;
  }
  set directories(e) {
    this._directories = e;
  }
  get directories() {
    return this._directories;
  }
  get dirs() {
    return this._directories;
  }
};
var Mt = class {
  aborted = false;
  abort() {
    this.aborted = true;
  }
};
var Nt = class {
  root;
  isSynchronous;
  state;
  joinPath;
  pushDirectory;
  pushFile;
  getArray;
  groupFiles;
  resolveSymlink;
  walkDirectory;
  callbackInvoker;
  constructor(e, t, n) {
    this.isSynchronous = !n;
    this.callbackInvoker = Tt(t, this.isSynchronous);
    this.root = Ve(e, t);
    this.state = {
      root: Be(this.root) ? this.root : this.root.slice(0, -1),
      paths: [``].slice(0, 0),
      groups: [],
      counts: new jt(),
      options: t,
      queue: new At((e, t) => this.callbackInvoker(t, e, n)),
      symlinks: new Map(),
      visited: [``].slice(0, 0),
      controller: new Mt(),
      fs: t.fs || W,
    };
    this.joinPath = Ke(this.root, t);
    this.pushDirectory = Qe(this.root, t);
    this.pushFile = it(t);
    this.getArray = st(t);
    this.groupFiles = ut(t);
    this.resolveSymlink = pt(t, this.isSynchronous);
    this.walkDirectory = kt(this.isSynchronous);
  }
  start() {
    this.pushDirectory(this.root, this.state.paths, this.state.options.filters);
    this.walkDirectory(
      this.state,
      this.root,
      this.root,
      this.state.options.maxDepth,
      this.walk,
    );
    if (this.isSynchronous) {
      return this.callbackInvoker(this.state, null);
    } else {
      return null;
    }
  }
  walk = (e, t, n) => {
    let {
      paths: r,
      options: {
        filters: i,
        resolveSymlinks: a,
        excludeSymlinks: o,
        exclude: s,
        maxFiles: c,
        signal: l,
        useRealPaths: u,
        pathSeparator: d,
      },
      controller: f,
    } = this.state;
    if (f.aborted || (l && l.aborted) || (c && r.length > c)) {
      return;
    }
    let p = this.getArray(this.state.paths);
    for (let c = 0; c < e.length; ++c) {
      let l = e[c];
      if (l.isFile() || (l.isSymbolicLink() && !a && !o)) {
        let e = this.joinPath(l.name, t);
        this.pushFile(e, p, this.state.counts, i);
      } else if (l.isDirectory()) {
        let e = Ge(l.name, t, this.state.options.pathSeparator);
        if (s && s(l.name, e)) {
          continue;
        }
        this.pushDirectory(e, r, i);
        this.walkDirectory(this.state, e, e, n - 1, this.walk);
      } else if (this.resolveSymlink && l.isSymbolicLink()) {
        let e = He(l.name, t);
        this.resolveSymlink(e, this.state, (t, r) => {
          if (t.isDirectory()) {
            r = Ve(r, this.state.options);
            if (s && s(l.name, u ? r : e + d)) {
              return;
            }
            this.walkDirectory(this.state, r, u ? r : e + d, n - 1, this.walk);
          } else {
            r = u ? r : e;
            let t = y(r);
            let n = Ve(b(r), this.state.options);
            r = this.joinPath(t, n);
            this.pushFile(r, p, this.state.counts, i);
          }
        });
      }
    }
    this.groupFiles(this.state.groups, t, p);
  };
};
function Pt(e, t) {
  return new Promise((n, r) => {
    Ft(e, t, (e, t) => {
      if (e) {
        return r(e);
      }
      n(t);
    });
  });
}
function Ft(e, t, n) {
  new Nt(e, t, n).start();
}
function It(e, t) {
  return new Nt(e, t).start();
}
var Lt = class {
  constructor(e, t) {
    this.root = e;
    this.options = t;
  }
  withPromise() {
    return Pt(this.root, this.options);
  }
  withCallback(e) {
    Ft(this.root, this.options, e);
  }
  sync() {
    return It(this.root, this.options);
  }
};
let Rt = null;
try {
  Fe.resolve(`picomatch`);
  Rt = Fe(`picomatch`);
} catch {}
var zt = class {
  globCache = {};
  options = {
    maxDepth: Infinity,
    suppressErrors: true,
    pathSeparator: T,
    filters: [],
  };
  globFunction;
  constructor(e) {
    this.options = {
      ...this.options,
      ...e,
    };
    this.globFunction = this.options.globFunction;
  }
  group() {
    this.options.group = true;
    return this;
  }
  withPathSeparator(e) {
    this.options.pathSeparator = e;
    return this;
  }
  withBasePath() {
    this.options.includeBasePath = true;
    return this;
  }
  withRelativePaths() {
    this.options.relativePaths = true;
    return this;
  }
  withDirs() {
    this.options.includeDirs = true;
    return this;
  }
  withMaxDepth(e) {
    this.options.maxDepth = e;
    return this;
  }
  withMaxFiles(e) {
    this.options.maxFiles = e;
    return this;
  }
  withFullPaths() {
    this.options.resolvePaths = true;
    this.options.includeBasePath = true;
    return this;
  }
  withErrors() {
    this.options.suppressErrors = false;
    return this;
  }
  withSymlinks({ resolvePaths: e = true } = {}) {
    this.options.resolveSymlinks = true;
    this.options.useRealPaths = e;
    return this.withFullPaths();
  }
  withAbortSignal(e) {
    this.options.signal = e;
    return this;
  }
  normalize() {
    this.options.normalizePath = true;
    return this;
  }
  filter(e) {
    this.options.filters.push(e);
    return this;
  }
  onlyDirs() {
    this.options.excludeFiles = true;
    this.options.includeDirs = true;
    return this;
  }
  exclude(e) {
    this.options.exclude = e;
    return this;
  }
  onlyCounts() {
    this.options.onlyCounts = true;
    return this;
  }
  crawl(e) {
    return new Lt(e || `.`, this.options);
  }
  withGlobFunction(e) {
    this.globFunction = e;
    return this;
  }
  crawlWithOptions(e, t) {
    this.options = {
      ...this.options,
      ...t,
    };
    return new Lt(e || `.`, this.options);
  }
  glob(...e) {
    if (this.globFunction) {
      return this.globWithOptions(e);
    } else {
      return this.globWithOptions(e, {
        dot: true,
      });
    }
  }
  globWithOptions(e, ...t) {
    let n = this.globFunction || Rt;
    if (!n) {
      throw Error(`Please specify a glob function to use glob matching.`);
    }
    var r = this.globCache[e.join(`\0`)];
    if (!r) {
      r = n(e, ...t);
      this.globCache[e.join(`\0`)] = r;
    }
    this.options.filters.push((e) => r(e));
    return this;
  }
};
var Bt = X((e, t) => {
  let n = `[^\\\\/]`;
  let r = `[^/]`;
  let i = `(?:\\/|$)`;
  let a = `(?:^|\\/)`;
  let o = `\\.{1,2}${i}`;
  let s = {
    DOT_LITERAL: `\\.`,
    PLUS_LITERAL: `\\+`,
    QMARK_LITERAL: `\\?`,
    SLASH_LITERAL: `\\/`,
    ONE_CHAR: `(?=.)`,
    QMARK: r,
    END_ANCHOR: i,
    DOTS_SLASH: o,
    NO_DOT: `(?!\\.)`,
    NO_DOTS: `(?!${a}${o})`,
    NO_DOT_SLASH: `(?!\\.{0,1}${i})`,
    NO_DOTS_SLASH: `(?!${o})`,
    QMARK_NO_DOT: `[^.\\/]`,
    STAR: `${r}*?`,
    START_ANCHOR: a,
    SEP: `/`,
  };
  let c = {
    ...s,
    SLASH_LITERAL: `[\\\\/]`,
    QMARK: n,
    STAR: `${n}*?`,
    DOTS_SLASH: `\\.{1,2}(?:[\\\\/]|$)`,
    NO_DOT: `(?!\\.)`,
    NO_DOTS: `(?!(?:^|[\\\\/])\\.{1,2}(?:[\\\\/]|$))`,
    NO_DOT_SLASH: `(?!\\.{0,1}(?:[\\\\/]|$))`,
    NO_DOTS_SLASH: `(?!\\.{1,2}(?:[\\\\/]|$))`,
    QMARK_NO_DOT: `[^.\\\\/]`,
    START_ANCHOR: `(?:^|[\\\\/])`,
    END_ANCHOR: `(?:[\\\\/]|$)`,
    SEP: `\\`,
  };
  t.exports = {
    MAX_LENGTH: 65536,
    POSIX_REGEX_SOURCE: {
      alnum: `a-zA-Z0-9`,
      alpha: `a-zA-Z`,
      ascii: `\\x00-\\x7F`,
      blank: ` \\t`,
      cntrl: `\\x00-\\x1F\\x7F`,
      digit: `0-9`,
      graph: `\\x21-\\x7E`,
      lower: `a-z`,
      print: `\\x20-\\x7E `,
      punct: `\\-!"#$%&'()\\*+,./:;<=>?@[\\]^_\`{|}~`,
      space: ` \\t\\r\\n\\v\\f`,
      upper: `A-Z`,
      word: `A-Za-z0-9_`,
      xdigit: `A-Fa-f0-9`,
    },
    REGEX_BACKSLASH: /\\(?![*+?^${}(|)[\]])/g,
    REGEX_NON_SPECIAL_CHARS: /^[^@![\].,$*+?^{}()|\\/]+/,
    REGEX_SPECIAL_CHARS: /[-*+?.^${}(|)[\]]/,
    REGEX_SPECIAL_CHARS_BACKREF: /(\\?)((\W)(\3*))/g,
    REGEX_SPECIAL_CHARS_GLOBAL: /([-*+?.^${}(|)[\]])/g,
    REGEX_REMOVE_BACKSLASH: /(?:\[.*?[^\\]\]|\\(?=.))/g,
    REPLACEMENTS: {
      __proto__: null,
      "***": `*`,
      "**/**": `**`,
      "**/**/**": `**`,
    },
    CHAR_0: 48,
    CHAR_9: 57,
    CHAR_UPPERCASE_A: 65,
    CHAR_LOWERCASE_A: 97,
    CHAR_UPPERCASE_Z: 90,
    CHAR_LOWERCASE_Z: 122,
    CHAR_LEFT_PARENTHESES: 40,
    CHAR_RIGHT_PARENTHESES: 41,
    CHAR_ASTERISK: 42,
    CHAR_AMPERSAND: 38,
    CHAR_AT: 64,
    CHAR_BACKWARD_SLASH: 92,
    CHAR_CARRIAGE_RETURN: 13,
    CHAR_CIRCUMFLEX_ACCENT: 94,
    CHAR_COLON: 58,
    CHAR_COMMA: 44,
    CHAR_DOT: 46,
    CHAR_DOUBLE_QUOTE: 34,
    CHAR_EQUAL: 61,
    CHAR_EXCLAMATION_MARK: 33,
    CHAR_FORM_FEED: 12,
    CHAR_FORWARD_SLASH: 47,
    CHAR_GRAVE_ACCENT: 96,
    CHAR_HASH: 35,
    CHAR_HYPHEN_MINUS: 45,
    CHAR_LEFT_ANGLE_BRACKET: 60,
    CHAR_LEFT_CURLY_BRACE: 123,
    CHAR_LEFT_SQUARE_BRACKET: 91,
    CHAR_LINE_FEED: 10,
    CHAR_NO_BREAK_SPACE: 160,
    CHAR_PERCENT: 37,
    CHAR_PLUS: 43,
    CHAR_QUESTION_MARK: 63,
    CHAR_RIGHT_ANGLE_BRACKET: 62,
    CHAR_RIGHT_CURLY_BRACE: 125,
    CHAR_RIGHT_SQUARE_BRACKET: 93,
    CHAR_SEMICOLON: 59,
    CHAR_SINGLE_QUOTE: 39,
    CHAR_SPACE: 32,
    CHAR_TAB: 9,
    CHAR_UNDERSCORE: 95,
    CHAR_VERTICAL_LINE: 124,
    CHAR_ZERO_WIDTH_NOBREAK_SPACE: 65279,
    extglobChars(e) {
      return {
        "!": {
          type: `negate`,
          open: `(?:(?!(?:`,
          close: `))${e.STAR})`,
        },
        "?": {
          type: `qmark`,
          open: `(?:`,
          close: `)?`,
        },
        "+": {
          type: `plus`,
          open: `(?:`,
          close: `)+`,
        },
        "*": {
          type: `star`,
          open: `(?:`,
          close: `)*`,
        },
        "@": {
          type: `at`,
          open: `(?:`,
          close: `)`,
        },
      };
    },
    globChars(e) {
      if (e === true) {
        return c;
      } else {
        return s;
      }
    },
  };
});
var Vt = X((e) => {
  let {
    REGEX_BACKSLASH: t,
    REGEX_REMOVE_BACKSLASH: n,
    REGEX_SPECIAL_CHARS: r,
    REGEX_SPECIAL_CHARS_GLOBAL: i,
  } = Bt();
  e.isObject = (e) => typeof e == `object` && !!e && !Array.isArray(e);
  e.hasRegexChars = (e) => r.test(e);
  e.isRegexChar = (t) => t.length === 1 && e.hasRegexChars(t);
  e.escapeRegex = (e) => e.replace(i, `\\$1`);
  e.toPosixSlashes = (e) => e.replace(t, `/`);
  e.isWindows = () => {
    if (typeof navigator < `u` && navigator.platform) {
      let e = navigator.platform.toLowerCase();
      return e === `win32` || e === `windows`;
    }
    if (typeof process < `u` && process.platform) {
      return process.platform === `win32`;
    } else {
      return false;
    }
  };
  e.removeBackslashes = (e) => e.replace(n, (e) => (e === `\\` ? `` : e));
  e.escapeLast = (t, n, r) => {
    let i = t.lastIndexOf(n, r);
    if (i === -1) {
      return t;
    } else if (t[i - 1] === `\\`) {
      return e.escapeLast(t, n, i - 1);
    } else {
      return `${t.slice(0, i)}\\${t.slice(i)}`;
    }
  };
  e.removePrefix = (e, t = {}) => {
    let n = e;
    if (n.startsWith(`./`)) {
      n = n.slice(2);
      t.prefix = `./`;
    }
    return n;
  };
  e.wrapOutput = (e, t = {}, n = {}) => {
    let r = `${n.contains ? `` : `^`}(?:${e})${n.contains ? `` : `$`}`;
    if (t.negated === true) {
      r = `(?:^(?!${r}).*$)`;
    }
    return r;
  };
  e.basename = (e, { windows: t } = {}) => {
    let n = e.split(t ? /[\\/]/ : `/`);
    let r = n[n.length - 1];
    if (r === ``) {
      return n[n.length - 2];
    } else {
      return r;
    }
  };
});
var Ht = X((e, t) => {
  let n = Vt();
  let {
    CHAR_ASTERISK: r,
    CHAR_AT: i,
    CHAR_BACKWARD_SLASH: a,
    CHAR_COMMA: o,
    CHAR_DOT: s,
    CHAR_EXCLAMATION_MARK: c,
    CHAR_FORWARD_SLASH: l,
    CHAR_LEFT_CURLY_BRACE: u,
    CHAR_LEFT_PARENTHESES: d,
    CHAR_LEFT_SQUARE_BRACKET: f,
    CHAR_PLUS: p,
    CHAR_QUESTION_MARK: m,
    CHAR_RIGHT_CURLY_BRACE: h,
    CHAR_RIGHT_PARENTHESES: g,
    CHAR_RIGHT_SQUARE_BRACKET: _,
  } = Bt();
  let v = (e) => e === l || e === a;
  let y = (e) => {
    if (e.isPrefix !== true) {
      e.depth = e.isGlobstar ? Infinity : 1;
    }
  };
  t.exports = (e, t) => {
    let b = t || {};
    let x = e.length - 1;
    let S = b.parts === true || b.scanToEnd === true;
    let C = [];
    let w = [];
    let T = [];
    let E = e;
    let D = -1;
    let O = 0;
    let k = 0;
    let ee = false;
    let A = false;
    let j = false;
    let M = false;
    let te = false;
    let N = false;
    let P = false;
    let F = false;
    let I = false;
    let L = false;
    let R = 0;
    let z;
    let B;
    let V = {
      value: ``,
      depth: 0,
      isGlob: false,
    };
    let H = () => D >= x;
    let U = () => E.charCodeAt(D + 1);
    let W = () => {
      z = B;
      return E.charCodeAt(++D);
    };
    while (D < x) {
      B = W();
      let e;
      if (B === a) {
        P = V.backslashes = true;
        B = W();
        if (B === u) {
          N = true;
        }
        continue;
      }
      if (N === true || B === u) {
        for (R++; H() !== true && (B = W()); ) {
          if (B === a) {
            P = V.backslashes = true;
            W();
            continue;
          }
          if (B === u) {
            R++;
            continue;
          }
          if (N !== true && B === s && (B = W()) === s) {
            ee = V.isBrace = true;
            j = V.isGlob = true;
            L = true;
            if (S === true) {
              continue;
            }
            break;
          }
          if (N !== true && B === o) {
            ee = V.isBrace = true;
            j = V.isGlob = true;
            L = true;
            if (S === true) {
              continue;
            }
            break;
          }
          if (B === h && (R--, R === 0)) {
            N = false;
            ee = V.isBrace = true;
            L = true;
            break;
          }
        }
        if (S === true) {
          continue;
        }
        break;
      }
      if (B === l) {
        C.push(D);
        w.push(V);
        V = {
          value: ``,
          depth: 0,
          isGlob: false,
        };
        if (L === true) {
          continue;
        }
        if (z === s && D === O + 1) {
          O += 2;
          continue;
        }
        k = D + 1;
        continue;
      }
      if (
        b.noext !== true &&
        (B === p || B === i || B === r || B === m || B === c) &&
        U() === d
      ) {
        j = V.isGlob = true;
        M = V.isExtglob = true;
        L = true;
        if (B === c && D === O) {
          I = true;
        }
        if (S === true) {
          while (H() !== true && (B = W())) {
            if (B === a) {
              P = V.backslashes = true;
              B = W();
              continue;
            }
            if (B === g) {
              j = V.isGlob = true;
              L = true;
              break;
            }
          }
          continue;
        }
        break;
      }
      if (B === r) {
        if (z === r) {
          te = V.isGlobstar = true;
        }
        j = V.isGlob = true;
        L = true;
        if (S === true) {
          continue;
        }
        break;
      }
      if (B === m) {
        j = V.isGlob = true;
        L = true;
        if (S === true) {
          continue;
        }
        break;
      }
      if (B === f) {
        while (H() !== true && (e = W())) {
          if (e === a) {
            P = V.backslashes = true;
            W();
            continue;
          }
          if (e === _) {
            A = V.isBracket = true;
            j = V.isGlob = true;
            L = true;
            break;
          }
        }
        if (S === true) {
          continue;
        }
        break;
      }
      if (b.nonegate !== true && B === c && D === O) {
        F = V.negated = true;
        O++;
        continue;
      }
      if (b.noparen !== true && B === d) {
        j = V.isGlob = true;
        if (S === true) {
          while (H() !== true && (B = W())) {
            if (B === d) {
              P = V.backslashes = true;
              B = W();
              continue;
            }
            if (B === g) {
              L = true;
              break;
            }
          }
          continue;
        }
        break;
      }
      if (j === true) {
        L = true;
        if (S === true) {
          continue;
        }
        break;
      }
    }
    if (b.noext === true) {
      M = false;
      j = false;
    }
    let G = E;
    let ne = ``;
    let K = ``;
    if (O > 0) {
      ne = E.slice(0, O);
      E = E.slice(O);
      k -= O;
    }
    if (G && j === true && k > 0) {
      G = E.slice(0, k);
      K = E.slice(k);
    } else if (j === true) {
      G = ``;
      K = E;
    } else {
      G = E;
    }
    if (
      G &&
      G !== `` &&
      G !== `/` &&
      G !== E &&
      v(G.charCodeAt(G.length - 1))
    ) {
      G = G.slice(0, -1);
    }
    if (b.unescape === true) {
      K &&= n.removeBackslashes(K);
      if (G && P === true) {
        G = n.removeBackslashes(G);
      }
    }
    let q = {
      prefix: ne,
      input: e,
      start: O,
      base: G,
      glob: K,
      isBrace: ee,
      isBracket: A,
      isGlob: j,
      isExtglob: M,
      isGlobstar: te,
      negated: F,
      negatedExtglob: I,
    };
    if (b.tokens === true) {
      q.maxDepth = 0;
      if (!v(B)) {
        w.push(V);
      }
      q.tokens = w;
    }
    if (b.parts === true || b.tokens === true) {
      let t;
      for (let n = 0; n < C.length; n++) {
        let r = t ? t + 1 : O;
        let i = C[n];
        let a = e.slice(r, i);
        if (b.tokens) {
          if (n === 0 && O !== 0) {
            w[n].isPrefix = true;
            w[n].value = ne;
          } else {
            w[n].value = a;
          }
          y(w[n]);
          q.maxDepth += w[n].depth;
        }
        if (n !== 0 || a !== ``) {
          T.push(a);
        }
        t = i;
      }
      if (t && t + 1 < e.length) {
        let n = e.slice(t + 1);
        T.push(n);
        if (b.tokens) {
          w[w.length - 1].value = n;
          y(w[w.length - 1]);
          q.maxDepth += w[w.length - 1].depth;
        }
      }
      q.slashes = C;
      q.parts = T;
    }
    return q;
  };
});
var Ut = X((e, t) => {
  let n = Bt();
  let r = Vt();
  let {
    MAX_LENGTH: i,
    POSIX_REGEX_SOURCE: a,
    REGEX_NON_SPECIAL_CHARS: o,
    REGEX_SPECIAL_CHARS_BACKREF: s,
    REPLACEMENTS: c,
  } = n;
  let l = (e, t) => {
    if (typeof t.expandRange == `function`) {
      return t.expandRange(...e, t);
    }
    e.sort();
    let n = `[${e.join(`-`)}]`;
    try {
      new RegExp(n);
    } catch {
      return e.map((e) => r.escapeRegex(e)).join(`..`);
    }
    return n;
  };
  let u = (e, t) =>
    `Missing ${e}: "${t}" - use "\\\\${t}" to match literal characters`;
  let d = (e, t) => {
    if (typeof e != `string`) {
      throw TypeError(`Expected a string`);
    }
    e = c[e] || e;
    let f = {
      ...t,
    };
    let p = typeof f.maxLength == `number` ? Math.min(i, f.maxLength) : i;
    let m = e.length;
    if (m > p) {
      throw SyntaxError(
        `Input length: ${m}, exceeds maximum allowed length: ${p}`,
      );
    }
    let h = {
      type: `bos`,
      value: ``,
      output: f.prepend || ``,
    };
    let g = [h];
    let _ = f.capture ? `` : `?:`;
    let v = n.globChars(f.windows);
    let y = n.extglobChars(v);
    let {
      DOT_LITERAL: b,
      PLUS_LITERAL: x,
      SLASH_LITERAL: S,
      ONE_CHAR: C,
      DOTS_SLASH: w,
      NO_DOT: T,
      NO_DOT_SLASH: E,
      NO_DOTS_SLASH: D,
      QMARK: O,
      QMARK_NO_DOT: k,
      STAR: ee,
      START_ANCHOR: A,
    } = v;
    let j = (e) => `(${_}(?:(?!${A}${e.dot ? w : b}).)*?)`;
    let M = f.dot ? `` : T;
    let te = f.dot ? O : k;
    let N = f.bash === true ? j(f) : ee;
    if (f.capture) {
      N = `(${N})`;
    }
    if (typeof f.noext == `boolean`) {
      f.noextglob = f.noext;
    }
    let P = {
      input: e,
      index: -1,
      start: 0,
      dot: f.dot === true,
      consumed: ``,
      output: ``,
      prefix: ``,
      backtrack: false,
      negated: false,
      brackets: 0,
      braces: 0,
      parens: 0,
      quotes: 0,
      globstar: false,
      tokens: g,
    };
    e = r.removePrefix(e, P);
    m = e.length;
    let F = [];
    let I = [];
    let L = [];
    let R = h;
    let z;
    let B = () => P.index === m - 1;
    let V = (P.peek = (t = 1) => e[P.index + t]);
    let H = (P.advance = () => e[++P.index] || ``);
    let U = () => e.slice(P.index + 1);
    let W = (e = ``, t = 0) => {
      P.consumed += e;
      P.index += t;
    };
    let G = (e) => {
      P.output += e.output == null ? e.value : e.output;
      W(e.value);
    };
    let ne = () => {
      let e = 1;
      while (V() === `!` && (V(2) !== `(` || V(3) === `?`)) {
        H();
        P.start++;
        e++;
      }
      if (e % 2 == 0) {
        return false;
      } else {
        P.negated = true;
        P.start++;
        return true;
      }
    };
    let K = (e) => {
      P[e]++;
      L.push(e);
    };
    let q = (e) => {
      P[e]--;
      L.pop();
    };
    let J = (e) => {
      if (R.type === `globstar`) {
        let t = P.braces > 0 && (e.type === `comma` || e.type === `brace`);
        let n =
          e.extglob === true ||
          (F.length && (e.type === `pipe` || e.type === `paren`));
        if (e.type !== `slash` && e.type !== `paren` && !t && !n) {
          P.output = P.output.slice(0, -R.output.length);
          R.type = `star`;
          R.value = `*`;
          R.output = N;
          P.output += R.output;
        }
      }
      if (F.length && e.type !== `paren`) {
        F[F.length - 1].inner += e.value;
      }
      if (e.value || e.output) {
        G(e);
      }
      if (R && R.type === `text` && e.type === `text`) {
        R.output = (R.output || R.value) + e.value;
        R.value += e.value;
        return;
      }
      e.prev = R;
      g.push(e);
      R = e;
    };
    let Y = (e, t) => {
      let n = {
        ...y[t],
        conditions: 1,
        inner: ``,
      };
      n.prev = R;
      n.parens = P.parens;
      n.output = P.output;
      let r = (f.capture ? `(` : ``) + n.open;
      K(`parens`);
      J({
        type: e,
        value: t,
        output: P.output ? `` : C,
      });
      J({
        type: `paren`,
        extglob: true,
        value: H(),
        output: r,
      });
      F.push(n);
    };
    let re = (e) => {
      let n = e.close + (f.capture ? `)` : ``);
      let r;
      if (e.type === `negate`) {
        let i = N;
        if (e.inner && e.inner.length > 1 && e.inner.includes(`/`)) {
          i = j(f);
        }
        if (i !== N || B() || /^\)+$/.test(U())) {
          n = e.close = `)$))${i}`;
        }
        if (e.inner.includes(`*`) && (r = U()) && /^\.[^\\/.]+$/.test(r)) {
          n = e.close = `)${
            d(r, {
              ...t,
              fastpaths: false,
            }).output
          })${i})`;
        }
        if (e.prev.type === `bos`) {
          P.negatedExtglob = true;
        }
      }
      J({
        type: `paren`,
        extglob: true,
        value: z,
        output: n,
      });
      q(`parens`);
    };
    if (f.fastpaths !== false && !/(^[*!]|[/()[\]{}"])/.test(e)) {
      let n = false;
      let i = e.replace(s, (e, t, r, i, a, o) =>
        i === `\\`
          ? ((n = true), e)
          : i === `?`
            ? t
              ? t + i + (a ? O.repeat(a.length) : ``)
              : o === 0
                ? te + (a ? O.repeat(a.length) : ``)
                : O.repeat(r.length)
            : i === `.`
              ? b.repeat(r.length)
              : i === `*`
                ? t
                  ? t + i + (a ? N : ``)
                  : N
                : t
                  ? e
                  : `\\${e}`,
      );
      if (n === true) {
        i =
          f.unescape === true
            ? i.replace(/\\/g, ``)
            : i.replace(/\\+/g, (e) =>
                e.length % 2 == 0 ? `\\\\` : e ? `\\` : ``,
              );
      }
      if (i === e && f.contains === true) {
        P.output = e;
        return P;
      } else {
        P.output = r.wrapOutput(i, P, t);
        return P;
      }
    }
    while (!B()) {
      z = H();
      if (z === `\0`) {
        continue;
      }
      if (z === `\\`) {
        let e = V();
        if ((e === `/` && f.bash !== true) || e === `.` || e === `;`) {
          continue;
        }
        if (!e) {
          z += `\\`;
          J({
            type: `text`,
            value: z,
          });
          continue;
        }
        let t = /^\\+/.exec(U());
        let n = 0;
        if (t && t[0].length > 2) {
          n = t[0].length;
          P.index += n;
          if (n % 2 != 0) {
            z += `\\`;
          }
        }
        if (f.unescape === true) {
          z = H();
        } else {
          z += H();
        }
        if (P.brackets === 0) {
          J({
            type: `text`,
            value: z,
          });
          continue;
        }
      }
      if (
        P.brackets > 0 &&
        (z !== `]` || R.value === `[` || R.value === `[^`)
      ) {
        if (f.posix !== false && z === `:`) {
          let e = R.value.slice(1);
          if (e.includes(`[`) && ((R.posix = true), e.includes(`:`))) {
            let e = R.value.lastIndexOf(`[`);
            let t = R.value.slice(0, e);
            let n = a[R.value.slice(e + 2)];
            if (n) {
              R.value = t + n;
              P.backtrack = true;
              H();
              if (!h.output && g.indexOf(R) === 1) {
                h.output = C;
              }
              continue;
            }
          }
        }
        if ((z === `[` && V() !== `:`) || (z === `-` && V() === `]`)) {
          z = `\\${z}`;
        }
        if (z === `]` && (R.value === `[` || R.value === `[^`)) {
          z = `\\${z}`;
        }
        if (f.posix === true && z === `!` && R.value === `[`) {
          z = `^`;
        }
        R.value += z;
        G({
          value: z,
        });
        continue;
      }
      if (P.quotes === 1 && z !== `"`) {
        z = r.escapeRegex(z);
        R.value += z;
        G({
          value: z,
        });
        continue;
      }
      if (z === `"`) {
        P.quotes = P.quotes === 1 ? 0 : 1;
        if (f.keepQuotes === true) {
          J({
            type: `text`,
            value: z,
          });
        }
        continue;
      }
      if (z === `(`) {
        K(`parens`);
        J({
          type: `paren`,
          value: z,
        });
        continue;
      }
      if (z === `)`) {
        if (P.parens === 0 && f.strictBrackets === true) {
          throw SyntaxError(u(`opening`, `(`));
        }
        let e = F[F.length - 1];
        if (e && P.parens === e.parens + 1) {
          re(F.pop());
          continue;
        }
        J({
          type: `paren`,
          value: z,
          output: P.parens ? `)` : `\\)`,
        });
        q(`parens`);
        continue;
      }
      if (z === `[`) {
        if (f.nobracket === true || !U().includes(`]`)) {
          if (f.nobracket !== true && f.strictBrackets === true) {
            throw SyntaxError(u(`closing`, `]`));
          }
          z = `\\${z}`;
        } else {
          K(`brackets`);
        }
        J({
          type: `bracket`,
          value: z,
        });
        continue;
      }
      if (z === `]`) {
        if (
          f.nobracket === true ||
          (R && R.type === `bracket` && R.value.length === 1)
        ) {
          J({
            type: `text`,
            value: z,
            output: `\\${z}`,
          });
          continue;
        }
        if (P.brackets === 0) {
          if (f.strictBrackets === true) {
            throw SyntaxError(u(`opening`, `[`));
          }
          J({
            type: `text`,
            value: z,
            output: `\\${z}`,
          });
          continue;
        }
        q(`brackets`);
        let e = R.value.slice(1);
        if (R.posix !== true && e[0] === `^` && !e.includes(`/`)) {
          z = `/${z}`;
        }
        R.value += z;
        G({
          value: z,
        });
        if (f.literalBrackets === false || r.hasRegexChars(e)) {
          continue;
        }
        let t = r.escapeRegex(R.value);
        P.output = P.output.slice(0, -R.value.length);
        if (f.literalBrackets === true) {
          P.output += t;
          R.value = t;
          continue;
        }
        R.value = `(${_}${t}|${R.value})`;
        P.output += R.value;
        continue;
      }
      if (z === `{` && f.nobrace !== true) {
        K(`braces`);
        let e = {
          type: `brace`,
          value: z,
          output: `(`,
          outputIndex: P.output.length,
          tokensIndex: P.tokens.length,
        };
        I.push(e);
        J(e);
        continue;
      }
      if (z === `}`) {
        let e = I[I.length - 1];
        if (f.nobrace === true || !e) {
          J({
            type: `text`,
            value: z,
            output: z,
          });
          continue;
        }
        let t = `)`;
        if (e.dots === true) {
          let e = g.slice();
          let n = [];
          for (
            let t = e.length - 1;
            t >= 0 && (g.pop(), e[t].type !== `brace`);
            t--
          ) {
            if (e[t].type !== `dots`) {
              n.unshift(e[t].value);
            }
          }
          t = l(n, f);
          P.backtrack = true;
        }
        if (e.comma !== true && e.dots !== true) {
          let n = P.output.slice(0, e.outputIndex);
          let r = P.tokens.slice(e.tokensIndex);
          e.value = e.output = `\\{`;
          z = t = `\\}`;
          P.output = n;
          for (let e of r) {
            P.output += e.output || e.value;
          }
        }
        J({
          type: `brace`,
          value: z,
          output: t,
        });
        q(`braces`);
        I.pop();
        continue;
      }
      if (z === `|`) {
        if (F.length > 0) {
          F[F.length - 1].conditions++;
        }
        J({
          type: `text`,
          value: z,
        });
        continue;
      }
      if (z === `,`) {
        let e = z;
        let t = I[I.length - 1];
        if (t && L[L.length - 1] === `braces`) {
          t.comma = true;
          e = `|`;
        }
        J({
          type: `comma`,
          value: z,
          output: e,
        });
        continue;
      }
      if (z === `/`) {
        if (R.type === `dot` && P.index === P.start + 1) {
          P.start = P.index + 1;
          P.consumed = ``;
          P.output = ``;
          g.pop();
          R = h;
          continue;
        }
        J({
          type: `slash`,
          value: z,
          output: S,
        });
        continue;
      }
      if (z === `.`) {
        if (P.braces > 0 && R.type === `dot`) {
          if (R.value === `.`) {
            R.output = b;
          }
          let e = I[I.length - 1];
          R.type = `dots`;
          R.output += z;
          R.value += z;
          e.dots = true;
          continue;
        }
        if (
          P.braces + P.parens === 0 &&
          R.type !== `bos` &&
          R.type !== `slash`
        ) {
          J({
            type: `text`,
            value: z,
            output: b,
          });
          continue;
        }
        J({
          type: `dot`,
          value: z,
          output: b,
        });
        continue;
      }
      if (z === `?`) {
        if (
          (!R || R.value !== `(`) &&
          f.noextglob !== true &&
          V() === `(` &&
          V(2) !== `?`
        ) {
          Y(`qmark`, z);
          continue;
        }
        if (R && R.type === `paren`) {
          let e = V();
          let t = z;
          if (
            (R.value === `(` && !/[!=<:]/.test(e)) ||
            (e === `<` && !/<([!=]|\w+>)/.test(U()))
          ) {
            t = `\\${z}`;
          }
          J({
            type: `text`,
            value: z,
            output: t,
          });
          continue;
        }
        if (f.dot !== true && (R.type === `slash` || R.type === `bos`)) {
          J({
            type: `qmark`,
            value: z,
            output: k,
          });
          continue;
        }
        J({
          type: `qmark`,
          value: z,
          output: O,
        });
        continue;
      }
      if (z === `!`) {
        if (
          f.noextglob !== true &&
          V() === `(` &&
          (V(2) !== `?` || !/[!=<:]/.test(V(3)))
        ) {
          Y(`negate`, z);
          continue;
        }
        if (f.nonegate !== true && P.index === 0) {
          ne();
          continue;
        }
      }
      if (z === `+`) {
        if (f.noextglob !== true && V() === `(` && V(2) !== `?`) {
          Y(`plus`, z);
          continue;
        }
        if ((R && R.value === `(`) || f.regex === false) {
          J({
            type: `plus`,
            value: z,
            output: x,
          });
          continue;
        }
        if (
          (R &&
            (R.type === `bracket` ||
              R.type === `paren` ||
              R.type === `brace`)) ||
          P.parens > 0
        ) {
          J({
            type: `plus`,
            value: z,
          });
          continue;
        }
        J({
          type: `plus`,
          value: x,
        });
        continue;
      }
      if (z === `@`) {
        if (f.noextglob !== true && V() === `(` && V(2) !== `?`) {
          J({
            type: `at`,
            extglob: true,
            value: z,
            output: ``,
          });
          continue;
        }
        J({
          type: `text`,
          value: z,
        });
        continue;
      }
      if (z !== `*`) {
        if (z === `$` || z === `^`) {
          z = `\\${z}`;
        }
        let e = o.exec(U());
        if (e) {
          z += e[0];
          P.index += e[0].length;
        }
        J({
          type: `text`,
          value: z,
        });
        continue;
      }
      if (R && (R.type === `globstar` || R.star === true)) {
        R.type = `star`;
        R.star = true;
        R.value += z;
        R.output = N;
        P.backtrack = true;
        P.globstar = true;
        W(z);
        continue;
      }
      let t = U();
      if (f.noextglob !== true && /^\([^?]/.test(t)) {
        Y(`star`, z);
        continue;
      }
      if (R.type === `star`) {
        if (f.noglobstar === true) {
          W(z);
          continue;
        }
        let n = R.prev;
        let r = n.prev;
        let i = n.type === `slash` || n.type === `bos`;
        let a = r && (r.type === `star` || r.type === `globstar`);
        if (f.bash === true && (!i || (t[0] && t[0] !== `/`))) {
          J({
            type: `star`,
            value: z,
            output: ``,
          });
          continue;
        }
        let o = P.braces > 0 && (n.type === `comma` || n.type === `brace`);
        let s = F.length && (n.type === `pipe` || n.type === `paren`);
        if (!i && n.type !== `paren` && !o && !s) {
          J({
            type: `star`,
            value: z,
            output: ``,
          });
          continue;
        }
        while (t.slice(0, 3) === `/**`) {
          let n = e[P.index + 4];
          if (n && n !== `/`) {
            break;
          }
          t = t.slice(3);
          W(`/**`, 3);
        }
        if (n.type === `bos` && B()) {
          R.type = `globstar`;
          R.value += z;
          R.output = j(f);
          P.output = R.output;
          P.globstar = true;
          W(z);
          continue;
        }
        if (n.type === `slash` && n.prev.type !== `bos` && !a && B()) {
          P.output = P.output.slice(0, -(n.output + R.output).length);
          n.output = `(?:${n.output}`;
          R.type = `globstar`;
          R.output = j(f) + (f.strictSlashes ? `)` : `|$)`);
          R.value += z;
          P.globstar = true;
          P.output += n.output + R.output;
          W(z);
          continue;
        }
        if (n.type === `slash` && n.prev.type !== `bos` && t[0] === `/`) {
          let e = t[1] === undefined ? `` : `|$`;
          P.output = P.output.slice(0, -(n.output + R.output).length);
          n.output = `(?:${n.output}`;
          R.type = `globstar`;
          R.output = `${j(f)}${S}|${S}${e})`;
          R.value += z;
          P.output += n.output + R.output;
          P.globstar = true;
          W(z + H());
          J({
            type: `slash`,
            value: `/`,
            output: ``,
          });
          continue;
        }
        if (n.type === `bos` && t[0] === `/`) {
          R.type = `globstar`;
          R.value += z;
          R.output = `(?:^|${S}|${j(f)}${S})`;
          P.output = R.output;
          P.globstar = true;
          W(z + H());
          J({
            type: `slash`,
            value: `/`,
            output: ``,
          });
          continue;
        }
        P.output = P.output.slice(0, -R.output.length);
        R.type = `globstar`;
        R.output = j(f);
        R.value += z;
        P.output += R.output;
        P.globstar = true;
        W(z);
        continue;
      }
      let n = {
        type: `star`,
        value: z,
        output: N,
      };
      if (f.bash === true) {
        n.output = `.*?`;
        if (R.type === `bos` || R.type === `slash`) {
          n.output = M + n.output;
        }
        J(n);
        continue;
      }
      if (
        R &&
        (R.type === `bracket` || R.type === `paren`) &&
        f.regex === true
      ) {
        n.output = z;
        J(n);
        continue;
      }
      if (P.index === P.start || R.type === `slash` || R.type === `dot`) {
        if (R.type === `dot`) {
          P.output += E;
          R.output += E;
        } else if (f.dot === true) {
          P.output += D;
          R.output += D;
        } else {
          P.output += M;
          R.output += M;
        }
        if (V() !== `*`) {
          P.output += C;
          R.output += C;
        }
      }
      J(n);
    }
    while (P.brackets > 0) {
      if (f.strictBrackets === true) {
        throw SyntaxError(u(`closing`, `]`));
      }
      P.output = r.escapeLast(P.output, `[`);
      q(`brackets`);
    }
    while (P.parens > 0) {
      if (f.strictBrackets === true) {
        throw SyntaxError(u(`closing`, `)`));
      }
      P.output = r.escapeLast(P.output, `(`);
      q(`parens`);
    }
    while (P.braces > 0) {
      if (f.strictBrackets === true) {
        throw SyntaxError(u(`closing`, `}`));
      }
      P.output = r.escapeLast(P.output, `{`);
      q(`braces`);
    }
    if (
      f.strictSlashes !== true &&
      (R.type === `star` || R.type === `bracket`)
    ) {
      J({
        type: `maybe_slash`,
        value: ``,
        output: `${S}?`,
      });
    }
    if (P.backtrack === true) {
      P.output = ``;
      for (let e of P.tokens) {
        P.output += e.output == null ? e.value : e.output;
        if (e.suffix) {
          P.output += e.suffix;
        }
      }
    }
    return P;
  };
  d.fastpaths = (e, t) => {
    let a = {
      ...t,
    };
    let o = typeof a.maxLength == `number` ? Math.min(i, a.maxLength) : i;
    let s = e.length;
    if (s > o) {
      throw SyntaxError(
        `Input length: ${s}, exceeds maximum allowed length: ${o}`,
      );
    }
    e = c[e] || e;
    let {
      DOT_LITERAL: l,
      SLASH_LITERAL: u,
      ONE_CHAR: d,
      DOTS_SLASH: f,
      NO_DOT: p,
      NO_DOTS: m,
      NO_DOTS_SLASH: h,
      STAR: g,
      START_ANCHOR: _,
    } = n.globChars(a.windows);
    let v = a.dot ? m : p;
    let y = a.dot ? h : p;
    let b = a.capture ? `` : `?:`;
    let x = {
      negated: false,
      prefix: ``,
    };
    let S = a.bash === true ? `.*?` : g;
    if (a.capture) {
      S = `(${S})`;
    }
    let C = (e) =>
      e.noglobstar === true ? S : `(${b}(?:(?!${_}${e.dot ? f : l}).)*?)`;
    let w = (e) => {
      switch (e) {
        case `*`:
          return `${v}${d}${S}`;
        case `.*`:
          return `${l}${d}${S}`;
        case `*.*`:
          return `${v}${S}${l}${d}${S}`;
        case `*/*`:
          return `${v}${S}${u}${d}${y}${S}`;
        case `**`:
          return v + C(a);
        case `**/*`:
          return `(?:${v}${C(a)}${u})?${y}${d}${S}`;
        case `**/*.*`:
          return `(?:${v}${C(a)}${u})?${y}${S}${l}${d}${S}`;
        case `**/.*`:
          return `(?:${v}${C(a)}${u})?${l}${d}${S}`;
        default: {
          let t = /^(.*?)\.(\w+)$/.exec(e);
          if (!t) {
            return;
          }
          let n = w(t[1]);
          if (n) {
            return n + l + t[2];
          } else {
            return undefined;
          }
        }
      }
    };
    let T = w(r.removePrefix(e, x));
    if (T && a.strictSlashes !== true) {
      T += `${u}?`;
    }
    return T;
  };
  t.exports = d;
});
var Wt = X((e, t) => {
  let n = Ht();
  let r = Ut();
  let i = Vt();
  let a = Bt();
  let o = (e) => e && typeof e == `object` && !Array.isArray(e);
  let s = (e, t, n = false) => {
    if (Array.isArray(e)) {
      let r = e.map((e) => s(e, t, n));
      return (e) => {
        for (let t of r) {
          let n = t(e);
          if (n) {
            return n;
          }
        }
        return false;
      };
    }
    let r = o(e) && e.tokens && e.input;
    if (e === `` || (typeof e != `string` && !r)) {
      throw TypeError(`Expected pattern to be a non-empty string`);
    }
    let i = t || {};
    let a = i.windows;
    let c = r ? s.compileRe(e, t) : s.makeRe(e, t, false, true);
    let l = c.state;
    delete c.state;
    let u = () => false;
    if (i.ignore) {
      let e = {
        ...t,
        ignore: null,
        onMatch: null,
        onResult: null,
      };
      u = s(i.ignore, e, n);
    }
    let d = (n, r = false) => {
      let {
        isMatch: o,
        match: d,
        output: f,
      } = s.test(n, c, t, {
        glob: e,
        posix: a,
      });
      let p = {
        glob: e,
        state: l,
        regex: c,
        posix: a,
        input: n,
        output: f,
        match: d,
        isMatch: o,
      };
      if (typeof i.onResult == `function`) {
        i.onResult(p);
      }
      if (o === false) {
        p.isMatch = false;
        if (r) {
          return p;
        } else {
          return false;
        }
      } else if (u(n)) {
        if (typeof i.onIgnore == `function`) {
          i.onIgnore(p);
        }
        p.isMatch = false;
        if (r) {
          return p;
        } else {
          return false;
        }
      } else {
        if (typeof i.onMatch == `function`) {
          i.onMatch(p);
        }
        if (r) {
          return p;
        } else {
          return true;
        }
      }
    };
    if (n) {
      d.state = l;
    }
    return d;
  };
  s.test = (e, t, n, { glob: r, posix: a } = {}) => {
    if (typeof e != `string`) {
      throw TypeError(`Expected input to be a string`);
    }
    if (e === ``) {
      return {
        isMatch: false,
        output: ``,
      };
    }
    let o = n || {};
    let c = o.format || (a ? i.toPosixSlashes : null);
    let l = e === r;
    let u = l && c ? c(e) : e;
    if (l === false) {
      u = c ? c(e) : e;
      l = u === r;
    }
    if (l === false || o.capture === true) {
      l =
        o.matchBase === true || o.basename === true
          ? s.matchBase(e, t, n, a)
          : t.exec(u);
    }
    return {
      isMatch: !!l,
      match: l,
      output: u,
    };
  };
  s.matchBase = (e, t, n) =>
    (t instanceof RegExp ? t : s.makeRe(t, n)).test(i.basename(e));
  s.isMatch = (e, t, n) => s(t, n)(e);
  s.parse = (e, t) =>
    Array.isArray(e)
      ? e.map((e) => s.parse(e, t))
      : r(e, {
          ...t,
          fastpaths: false,
        });
  s.scan = (e, t) => n(e, t);
  s.compileRe = (e, t, n = false, r = false) => {
    if (n === true) {
      return e.output;
    }
    let i = t || {};
    let a = i.contains ? `` : `^`;
    let o = i.contains ? `` : `$`;
    let c = `${a}(?:${e.output})${o}`;
    if (e && e.negated === true) {
      c = `^(?!${c}).*$`;
    }
    let l = s.toRegex(c, t);
    if (r === true) {
      l.state = e;
    }
    return l;
  };
  s.makeRe = (e, t = {}, n = false, i = false) => {
    if (!e || typeof e != `string`) {
      throw TypeError(`Expected a non-empty string`);
    }
    let a = {
      negated: false,
      fastpaths: true,
    };
    if (t.fastpaths !== false && (e[0] === `.` || e[0] === `*`)) {
      a.output = r.fastpaths(e, t);
    }
    if (!a.output) {
      a = r(e, t);
    }
    return s.compileRe(a, t, n, i);
  };
  s.toRegex = (e, t) => {
    try {
      let n = t || {};
      return new RegExp(e, n.flags || (n.nocase ? `i` : ``));
    } catch (e) {
      if (t && t.debug === true) {
        throw e;
      }
      return /$^/;
    }
  };
  s.constants = a;
  t.exports = s;
});
var Gt = me(
  X((e, t) => {
    let n = Wt();
    let r = Vt();
    function i(e, t, i = false) {
      if (t && (t.windows === null || t.windows === undefined)) {
        t = {
          ...t,
          windows: r.isWindows(),
        };
      }
      return n(e, t, i);
    }
    Object.assign(i, n);
    t.exports = i;
  })(),
  1,
);
const Kt = Array.isArray;
const qt = process.platform === `win32`;
const Jt = /^(\/?\.\.)+$/;
function Yt(e, t = {}) {
  let n = e.length;
  let r = Array(n);
  let i = Array(n);
  let a = !t.noglobstar;
  for (let a = 0; a < n; a++) {
    let n = tn(e[a]);
    r[a] = n;
    let o = n.length;
    let s = Array(o);
    for (let e = 0; e < o; e++) {
      s[e] = (0, Gt.default)(n[e], t);
    }
    i[a] = s;
  }
  return (t) => {
    let n = t.split(`/`);
    if (n[0] === `..` && Jt.test(t)) {
      return true;
    }
    for (let t = 0; t < e.length; t++) {
      let e = r[t];
      let o = i[t];
      let s = n.length;
      let c = Math.min(s, e.length);
      let l = 0;
      while (l < c) {
        let t = e[l];
        if (t.includes(`/`)) {
          return true;
        }
        if (!o[l](n[l])) {
          break;
        }
        if (a && t === `**`) {
          return true;
        }
        l++;
      }
      if (l === s) {
        return true;
      }
    }
    return false;
  };
}
const Xt = /^[A-Z]:\/$/i;
const Zt = qt ? (e) => Xt.test(e) : (e) => e === `/`;
function Qt(e, t, n) {
  if (e === t || t.startsWith(`${e}/`)) {
    if (n) {
      let t = Zt(e) ? e.length : e.length + 1;
      return (e, n) => e.slice(t, n ? -1 : undefined) || `.`;
    }
    let r = t.slice(e.length + 1);
    if (r) {
      return (e, t) => {
        if (e === `.`) {
          return r;
        }
        let n = `${r}/${e}`;
        if (t) {
          return n.slice(0, -1);
        } else {
          return n;
        }
      };
    } else {
      return (e, t) => (t && e !== `.` ? e.slice(0, -1) : e);
    }
  }
  if (n) {
    return (t) => S.relative(e, t) || `.`;
  } else {
    return (n) => S.relative(e, `${t}/${n}`) || `.`;
  }
}
function $t(e, t) {
  if (t.startsWith(`${e}/`)) {
    let n = t.slice(e.length + 1);
    return (e) => `${n}/${e}`;
  }
  return (n) => {
    let r = S.relative(e, `${t}/${n}`);
    if (n.endsWith(`/`) && r !== ``) {
      return `${r}/`;
    } else {
      return r || `.`;
    }
  };
}
const en = {
  parts: true,
};
function tn(e) {
  let t = Gt.default.scan(e, en);
  if (t.parts?.length) {
    return t.parts;
  } else {
    return [e];
  }
}
const nn = /(?<!\\)([()[\]{}*?|]|^!|[!+@](?=\()|\\(?![()[\]{}!*+?@|]))/g;
const rn = /(?<!\\)([()[\]{}]|^!|[!+@](?=\())/g;
const an = qt ? (e) => e.replace(rn, `\\$&`) : (e) => e.replace(nn, `\\$&`);
function on(e, t) {
  if (t?.caseSensitiveMatch === false) {
    return true;
  }
  let n = Gt.default.scan(e);
  return n.isGlob || n.negated;
}
function sn(...e) {
  console.log(`[tinyglobby ${new Date().toLocaleTimeString(`es`)}]`, ...e);
}
const cn = /^(\/?\.\.)+/;
const ln = /\\(?=[()[\]{}!*+?@|])/g;
const un = /\\/g;
function dn(e, t, n, r, i) {
  let a = e;
  if (e.endsWith(`/`)) {
    a = e.slice(0, -1);
  }
  if (!a.endsWith(`*`) && t) {
    a += `/**`;
  }
  let o = an(n);
  a = v.isAbsolute(a.replace(ln, ``)) ? S.relative(o, a) : S.normalize(a);
  let s = cn.exec(a);
  let c = tn(a);
  if (s?.[0]) {
    let e = (s[0].length + 1) / 3;
    let t = 0;
    let i = o.split(`/`);
    while (t < e && c[t + e] === i[i.length + t - e]) {
      a =
        a.slice(0, (e - t - 1) * 3) +
          a.slice((e - t) * 3 + c[t + e].length + 1) || `.`;
      t++;
    }
    let l = S.join(n, s[0].slice(t * 3));
    if (!l.startsWith(`.`) && r.root.length > l.length) {
      r.root = l;
      r.depthOffset = -e + t;
    }
  }
  if (!i && r.depthOffset >= 0) {
    r.commonPath ??= c;
    let e = [];
    let t = Math.min(r.commonPath.length, c.length);
    for (let n = 0; n < t; n++) {
      let t = c[n];
      if (t === `**` && !c[n + 1]) {
        e.pop();
        break;
      }
      if (t !== r.commonPath[n] || on(t) || n === c.length - 1) {
        break;
      }
      e.push(t);
    }
    r.depthOffset = e.length;
    r.commonPath = e;
    r.root = e.length > 0 ? S.join(n, ...e) : n;
  }
  return a;
}
function fn(
  { patterns: e = [`**/*`], ignore: t = [], expandDirectories: n = true },
  r,
  i,
) {
  if (typeof e == `string`) {
    e = [e];
  }
  if (typeof t == `string`) {
    t = [t];
  }
  let a = [];
  let o = [];
  for (let e of t) {
    if (e && (e[0] !== `!` || e[1] === `(`)) {
      o.push(dn(e, n, r, i, true));
    }
  }
  for (let t of e) {
    if (t) {
      if (t[0] !== `!` || t[1] === `(`) {
        a.push(dn(t, n, r, i, false));
      } else if (t[1] !== `!` || t[2] === `(`) {
        o.push(dn(t.slice(1), n, r, i, true));
      }
    }
  }
  return {
    match: a,
    ignore: o,
  };
}
function pn(e, t) {
  for (let n = e.length - 1; n >= 0; n--) {
    let r = e[n];
    e[n] = t(r);
  }
  return e;
}
function mn(e) {
  if (e) {
    if (e instanceof URL) {
      return ne(e).replace(un, `/`);
    } else {
      return v.resolve(e).replace(un, `/`);
    }
  } else {
    return process.cwd().replace(un, `/`);
  }
}
function hn(e, t = {}) {
  let n = process.env.TINYGLOBBY_DEBUG
    ? {
        ...t,
        debug: true,
      }
    : t;
  let r = mn(n.cwd);
  if (n.debug) {
    sn(`globbing with:`, {
      patterns: e,
      options: n,
      cwd: r,
    });
  }
  if (Array.isArray(e) && e.length === 0) {
    return [
      {
        sync: () => [],
        withPromise: async () => [],
      },
      false,
    ];
  }
  let i = {
    root: r,
    commonPath: null,
    depthOffset: 0,
  };
  let a = fn(
    {
      ...n,
      patterns: e,
    },
    r,
    i,
  );
  if (n.debug) {
    sn(`internal processing patterns:`, a);
  }
  let o = {
    dot: n.dot,
    nobrace: n.braceExpansion === false,
    nocase: n.caseSensitiveMatch === false,
    noextglob: n.extglob === false,
    noglobstar: n.globstar === false,
    posix: true,
  };
  let s = (0, Gt.default)(a.match, {
    ...o,
    ignore: a.ignore,
  });
  let c = (0, Gt.default)(a.ignore, o);
  let l = Yt(a.match, o);
  let u = Qt(r, i.root, n.absolute);
  let d = n.absolute ? u : Qt(r, i.root, true);
  let f = {
    filters: [
      n.debug
        ? (e, t) => {
            let n = u(e, t);
            let r = s(n);
            if (r) {
              sn(`matched ${n}`);
            }
            return r;
          }
        : (e, t) => s(u(e, t)),
    ],
    exclude: n.debug
      ? (e, t) => {
          let n = d(t, true);
          let r = (n !== `.` && !l(n)) || c(n);
          sn(r ? `skipped ${t}` : `crawling ${t}`);
          return r;
        }
      : (e, t) => {
          let n = d(t, true);
          return (n !== `.` && !l(n)) || c(n);
        },
    fs: n.fs
      ? {
          readdir: n.fs.readdir || G.readdir,
          readdirSync: n.fs.readdirSync || G.readdirSync,
          realpath: n.fs.realpath || G.realpath,
          realpathSync: n.fs.realpathSync || G.realpathSync,
          stat: n.fs.stat || G.stat,
          statSync: n.fs.statSync || G.statSync,
        }
      : undefined,
    pathSeparator: `/`,
    relativePaths: true,
    resolveSymlinks: true,
    signal: n.signal,
  };
  if (n.deep !== undefined) {
    f.maxDepth = Math.round(n.deep - i.depthOffset);
  }
  if (n.absolute) {
    f.relativePaths = false;
    f.resolvePaths = true;
    f.includeBasePath = true;
  }
  if (n.followSymbolicLinks === false) {
    f.resolveSymlinks = false;
    f.excludeSymlinks = true;
  }
  if (n.onlyDirectories) {
    f.excludeFiles = true;
    f.includeDirs = true;
  } else if (n.onlyFiles === false) {
    f.includeDirs = true;
  }
  i.root = i.root.replace(un, ``);
  let p = i.root;
  if (n.debug) {
    sn(`internal properties:`, i);
  }
  let m = r !== p && !n.absolute && $t(r, i.root);
  return [new zt(f).crawl(p), m];
}
async function gn(e, t) {
  if (e && t?.patterns) {
    throw Error(`Cannot pass patterns as both an argument and an option`);
  }
  let n = Kt(e) || typeof e == `string`;
  let r = n ? t : e;
  let [i, a] = hn(n ? e : e.patterns, r);
  if (a) {
    return pn(await i.withPromise(), a);
  } else {
    return i.withPromise();
  }
}
const _n = async () => {
  {
    let { macOSVersion: e } = await import(`./macos-version-DLfxMdhC.js`);
    return {
      platform: `macos`,
      version: e() || P.release(),
    };
  }
  return {
    platform: process.platform,
    version: P.release(),
  };
};
function vn() {
  return L.join(P.homedir(), `Library`, `Caches`);
}
const yn = `app.chatwise`;
const bn = L.join(c.getPath(`appData`), yn);
const xn = L.join(L.dirname(c.getPath(`logs`)), yn);
const Sn = L.join(vn(), yn);
const Cn = import.meta.dirname;
const wn = L.join(Cn, `../client`);
const Tn = L.join(Cn, `../../resources`);
P.tmpdir();
const En = L.join(bn, `bin`);
function Dn(e) {
  function t(e, t, n) {
    let r = t.toLowerCase();
    for (let t of Object.keys(e)) {
      if (t.toLowerCase() === r) {
        e[t] = n;
        return;
      }
    }
    e[t] = n;
  }
  e.webContents.session.webRequest.onBeforeSendHeaders((e, n) => {
    let { requestHeaders: r } = e;
    t(r, `Access-Control-Allow-Origin`, [`*`]);
    t(r, `Origin`, [`*`]);
    t(r, `Sec-Fetch-Mode`, [`no-cors`]);
    t(r, `Sec-Fetch-Site`, [`none`]);
    t(r, `Sec-Fetch-Dest`, [`document`]);
    if (!e.url.includes(`github.com`)) {
      t(r, `User-Agent`, `node`);
    }
    n({
      requestHeaders: r,
    });
  });
  e.webContents.session.webRequest.onHeadersReceived((e, n) => {
    let r = e.responseHeaders || {};
    t(r, `Access-Control-Allow-Origin`, [`*`]);
    t(r, `Access-Control-Allow-Headers`, [`*`]);
    if (e.method === `OPTIONS`) {
      e.statusCode = 200;
      e.statusLine = `HTTP/1.1 200 OK`;
      e.responseHeaders = r;
      return n(e);
    }
    n({
      responseHeaders: r,
    });
  });
}
const On = L.join(bn, `.window_state.json`);
function kn() {
  try {
    let e = F.readFileSync(On, `utf8`);
    return JSON.parse(e);
  } catch {
    return {};
  }
}
function An(e) {
  try {
    let t = e.getBounds();
    let n = {
      x: t.x,
      y: t.y,
      width: t.width,
      height: t.height,
      isMaximized: e.isMaximized(),
    };
    let r = L.dirname(On);
    F.mkdirSync(r, {
      recursive: true,
    });
    F.writeFileSync(On, JSON.stringify(n, null, 2));
  } catch (e) {
    console.error(`Failed to save window state:`, e);
  }
}
function jn(e) {
  let t = kn();
  if (t.isMaximized) {
    e.maximize();
  } else {
    e.setBounds({
      ...(t.x === undefined
        ? {}
        : {
            x: t.x,
          }),
      ...(t.y === undefined
        ? {}
        : {
            y: t.y,
          }),
      ...(t.width === undefined
        ? {}
        : {
            width: t.width,
          }),
      ...(t.height === undefined
        ? {}
        : {
            height: t.height,
          }),
    });
  }
  e.on(`close`, () => {
    An(e);
  });
}
const Mn = [
  `<local>`,
  `0.0.0.0`,
  `*.local`,
  `*.test`,
  `*.localhost`,
  `192.168.0.0/16`,
  `10.0.0.0/8`,
  `172.16.0.0/12`,
].join(`;`);
const Nn = v.join(bn, `local_settings.json`);
function Pn() {
  if (G.existsSync(Nn)) {
    return JSON.parse(G.readFileSync(Nn, `utf8`));
  } else {
    return {};
  }
}
async function Fn(e) {
  await G.promises.mkdir(v.dirname(Nn), {
    recursive: true,
  });
  let t = Pn();
  await G.promises.writeFile(
    Nn,
    JSON.stringify({
      ...t,
      ...e,
    }),
  );
}
async function In() {
  let e = Pn();
  let t = e.proxy_url;
  let n = e.proxy_bypass_rules || Mn;
  let r = h.defaultSession;
  if (t) {
    await r.setProxy({
      mode: `fixed_servers`,
      proxyRules: t,
      proxyBypassRules: n,
    });
  } else {
    await r.setProxy({
      mode: `system`,
    });
  }
}
let Ln = null;
function Rn() {
  return (Pn().app_icon_display ?? `default`) !== `dock-only`;
}
function zn() {
  let e = Pn();
  let t = e.app_icon_display ?? `default`;
  let n = e.auto_hide_dock_icon ?? false;
  return t !== `dock-only` && n;
}
function Bn(e) {
  if (e) {
    if (Rn() && !c.dock?.isVisible()) {
      c.dock?.show();
    }
  } else if (zn() && c.dock?.isVisible()) {
    c.dock?.hide();
  }
}
function Vn() {
  return f.createFromPath(L.join(Tn, `trayTemplate.png`));
}
function Hn() {
  if (!Rn()) {
    return;
  }
  Ln = new o(Vn());
  let e = r.buildFromTemplate([
    {
      label: `Open`,
      click: () => {
        ur();
      },
    },
    {
      label: `Settings`,
      click: () => {
        cr();
      },
    },
    {
      type: `separator`,
    },
    {
      label: process.platform === `linux` ? `Exit` : `Quit`,
      role: process.platform === `linux` ? undefined : `quit`,
      click:
        process.platform === `linux`
          ? () => {
              c.exit(0);
            }
          : undefined,
    },
  ]);
  Ln.setToolTip(`ChatWise`);
  Ln.on(`click`, () => {
    ur();
  });
  Ln.on(`right-click`, () => {
    Ln?.popUpContextMenu(e);
  });
}
var Un = [
  {
    version: 20241108104738,
    description: `init`,
    sql: "CREATE TABLE `chat` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`createdAt` integer NOT NULL,\n\t`title` text NOT NULL,\n\t`model` text,\n\t`lastReplyAt` integer\n);\n--> statement-breakpoint\nCREATE TABLE `kv` (\n\t`key` text PRIMARY KEY NOT NULL,\n\t`value` text\n);\n--> statement-breakpoint\nCREATE TABLE `message` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`chatId` text NOT NULL,\n\t`createdAt` integer NOT NULL,\n\t`content` text NOT NULL,\n\t`role` text NOT NULL,\n\t`model` text,\n\t`files` text\n);\n--> statement-breakpoint\nCREATE INDEX `message_chatId_idx` ON `message` (`chatId`);",
    checksum: Buffer.from(
      `092959aced0a188d6b2c59758f8e6b0c4a1cfe18bfec2b0f86a8dceb367e98bf7cc4701f67e81e7ab68b8fb7e684b1c8`,
      `hex`,
    ),
  },
  {
    version: 20241110104419,
    description: `websearch`,
    sql: "ALTER TABLE `chat` ADD `webSearch` integer;",
    checksum: Buffer.from(
      `455d3bb149322f888b670fe0154c3c624482555734200e2f3388327d7b43c4c790f88ecc4a36271946dba8d53ef92f76`,
      `hex`,
    ),
  },
  {
    version: 20241112145950,
    description: `chat_settings`,
    sql: "ALTER TABLE `chat` ADD `systemInstruction` text;--> statement-breakpoint\nALTER TABLE `chat` ADD `temperature` real;",
    checksum: Buffer.from(
      `c7ed5cbf4b1963eed7b826acc95c370acfebebc4072bb833347f72064628fbd37e2db60827f782f73acb8a7395864587`,
      `hex`,
    ),
  },
  {
    version: 20241116151456,
    description: `websearchresult`,
    sql: "ALTER TABLE `message` ADD `webSearchResult` text;",
    checksum: Buffer.from(
      `12b52876b2f95df0b721117d341644f2ff717ad5e24e221ea3238130ced75191e788d3ab7a17f3e4920f4f199eefab24`,
      `hex`,
    ),
  },
  {
    version: 20241127122259,
    description: `favoritedat`,
    sql: "ALTER TABLE `chat` ADD `favoritedAt` integer;",
    checksum: Buffer.from(
      `5e7dc2ad2605b82aed452eb04c0d669f6df3ff8ead86ba0a15929d2863a0ba0953edc50be174b9d91b1662ad0131acd5`,
      `hex`,
    ),
  },
  {
    version: 20241210080233,
    description: `citations`,
    sql: "ALTER TABLE `message` ADD `citations` text;",
    checksum: Buffer.from(
      `218fda1ff6d9b3a2b7a16691b709c831edb7e28e8443f6d52e7d547ace17fa377c42d0369e21cc3a4a931c0a94dac5fa`,
      `hex`,
    ),
  },
  {
    version: 20241216141108,
    description: `truncate_and_lang`,
    sql: "ALTER TABLE `chat` ADD `replyLanguage` text;--> statement-breakpoint\nALTER TABLE `chat` ADD `truncateMessages` text;",
    checksum: Buffer.from(
      `6fd2a2e5326887fcbc653b49e4f7c1a577bc20f608b2d7973a3046c41a2145f152dd42445009b96be82adda8b2fd6701`,
      `hex`,
    ),
  },
  {
    version: 20241220121813,
    description: `assistant`,
    sql: "CREATE TABLE `assistant` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`createdAt` integer NOT NULL,\n\t`name` text NOT NULL,\n\t`icon` text,\n\t`description` text,\n\t`model` text,\n\t`temperature` real,\n\t`systemInstruction` text,\n\t`replyLanguage` text,\n\t`truncateMessages` text\n);\n--> statement-breakpoint\nALTER TABLE `chat` ADD `assistantId` text;--> statement-breakpoint\nCREATE INDEX `chat_assistantId_idx` ON `chat` (`assistantId`);",
    checksum: Buffer.from(
      `bf0179b8685e27d612193415c409ee4864b78627103e3134aed54d40724c4ad43407ae1fb5ecb10ef701e5399a508647`,
      `hex`,
    ),
  },
  {
    version: 20241224122210,
    description: `math`,
    sql: "ALTER TABLE `assistant` ADD `renderMath` integer;--> statement-breakpoint\nALTER TABLE `chat` ADD `renderMath` integer;",
    checksum: Buffer.from(
      `dacfe6b9dcef437b40007272112a442259211c64a46d996dff7a4ef3ae72a4be6d041684372620989da4c5710e97bd2a`,
      `hex`,
    ),
  },
  {
    version: 20250104085359,
    description: `prompt`,
    sql: "CREATE TABLE `prompt` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`createdAt` integer NOT NULL,\n\t`updatedAt` integer,\n\t`displayId` text NOT NULL,\n\t`title` text NOT NULL,\n\t`prompt` text NOT NULL,\n\t`variables` text\n);\n--> statement-breakpoint\nCREATE UNIQUE INDEX `prompt_displayId_unique` ON `prompt` (`displayId`);",
    checksum: Buffer.from(
      `786e334d0e37e5c9b553abddc0f091585b4a96f84f353bfda445882d3eb5ccaf043d401f750ad5e57bce4d01ce145d45`,
      `hex`,
    ),
  },
  {
    version: 20250105171026,
    description: `timetofinish`,
    sql: "ALTER TABLE `message` ADD `timeToFirstToken` integer;--> statement-breakpoint\nALTER TABLE `message` ADD `timeToFinish` integer;",
    checksum: Buffer.from(
      `01feb58a4659485e3bc2fb3c9d0804265cc782317004f0063e4079cd29eed6ce1ab5b75b4f542302f8e36ddc876255b5`,
      `hex`,
    ),
  },
  {
    version: 20250111140421,
    description: `assistant_id`,
    sql: "ALTER TABLE `assistant` ADD `displayId` text;--> statement-breakpoint\nCREATE UNIQUE INDEX `assistant_displayId_unique` ON `assistant` (`displayId`);\n\n-- update every assistant to make displayId default value to id\nUPDATE `assistant` SET `displayId` = `id`;",
    checksum: Buffer.from(
      `f41411416e9ee656bef4c8017e243a488aef8a2a0c0ab4d7ff4950773c3b7e3205e3fe1bb368e98d74cf91b819080529`,
      `hex`,
    ),
  },
  {
    version: 20250115105838,
    description: `artifacts`,
    sql: "ALTER TABLE `chat` ADD `artifacts` integer;",
    checksum: Buffer.from(
      `69d2a6114b269a73b0e58279c4a5e0398ee3b79a0c342974c798597c553fbd76a1bf02e6127cc6e3ea0714102c8d72af`,
      `hex`,
    ),
  },
  {
    version: 20250120145139,
    description: `reason`,
    sql: "ALTER TABLE `message` ADD `reasoningContent` text;--> statement-breakpoint\nALTER TABLE `message` ADD `reasoningTime` integer;",
    checksum: Buffer.from(
      `a96d16438587daf64ab7c7069d6bbe0af6f4d211da72fa60ebc1d8a4bc26c7dc4d5843a7d5eafd390a077cdb09cf8c47`,
      `hex`,
    ),
  },
  {
    version: 20250129081245,
    description: `chat_artifacts`,
    sql: "ALTER TABLE `assistant` ADD `webSearch` integer;--> statement-breakpoint\nALTER TABLE `assistant` ADD `artifacts` integer;--> statement-breakpoint\n",
    checksum: Buffer.from(
      `4922eeef082a6b4506020b0c186bf144a0822488e6aef1f29728be7ebb97e68378df73098a79b59364285777650bd71f`,
      `hex`,
    ),
  },
  {
    version: 20250201045035,
    description: `reasoning_effort`,
    sql: "ALTER TABLE `assistant` ADD `reasoningEffort` text;--> statement-breakpoint\nALTER TABLE `chat` ADD `reasoningEffort` text;",
    checksum: Buffer.from(
      `7bf87c45a0e8fbac621d4e76c070d68007eceafa213cdc000071be5e92a81bb262a0af19d4426c0793254ec4649a2251`,
      `hex`,
    ),
  },
  {
    version: 20250201093844,
    description: `custom_provider`,
    sql: "CREATE TABLE `provider` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`createdAt` integer NOT NULL,\n\t`updatedAt` integer,\n\t`name` text NOT NULL,\n\t`baseUrl` text NOT NULL,\n\t`models` text,\n\t`apiKey` text\n);\n",
    checksum: Buffer.from(
      `33a3dd795ade7a1fd4e585068c9abc88af7b51f53df7f894ad9fb11a6c2831e27cc9789e53ff92d31028e80b0ddc6def`,
      `hex`,
    ),
  },
  {
    version: 20250208080333,
    description: `websearchmodel`,
    sql: "ALTER TABLE `message` ADD `webSearchModel` text;",
    checksum: Buffer.from(
      `3829f2fc625184e2a15d10d8b4bb8b1b577498d0facdce7fbd0cf1a05f1dad39b952a58b3bc04118b679b6a39dc91b60`,
      `hex`,
    ),
  },
  {
    version: 20250214110311,
    description: `max_tokens`,
    sql: "ALTER TABLE `assistant` ADD `maxOutputTokens` integer;--> statement-breakpoint\nALTER TABLE `chat` ADD `maxOutputTokens` integer;",
    checksum: Buffer.from(
      `c7e6ca13658bef292752c88f67aa7165cfbcdc9847839139139382118d1b7f3c633203203ce41e3fd7424c9385682cdc`,
      `hex`,
    ),
  },
  {
    version: 20250220074358,
    description: `updated_at`,
    sql: "ALTER TABLE `assistant` ADD `updatedAt` integer;--> statement-breakpoint\nALTER TABLE `chat` ADD `updatedAt` integer;--> statement-breakpoint\nALTER TABLE `message` ADD `updatedAt` integer;",
    checksum: Buffer.from(
      `9a67b62236afa894366b9bebb477650e90eb26a3ba7614d36c4ea01c3b46e3db2d259c837e190d2ec51fd03ee4852707`,
      `hex`,
    ),
  },
  {
    version: 20250224194027,
    description: `message_meta`,
    sql: "ALTER TABLE `message` ADD `meta` text;",
    checksum: Buffer.from(
      `73130b495e033ae7e26a6b1de3ef7314d696f572b9c233eeaec4b80560b1385e0170ff932354d724fa3c995c5251b714`,
      `hex`,
    ),
  },
  {
    version: 20250225064328,
    description: `provider_type`,
    sql: "ALTER TABLE `provider` ADD `type` text DEFAULT 'openai';",
    checksum: Buffer.from(
      `a0391fae1a7ca57a5d385fbee4ce7ba6f329ae41bd799110770abbf78edbb892e7ed1aacf353b13773dc39e5198a538a`,
      `hex`,
    ),
  },
  {
    version: 20250304065244,
    description: `show_assistant`,
    sql: "ALTER TABLE `assistant` ADD `showInSidebar` integer;",
    checksum: Buffer.from(
      `d78e21d1f079dde60207b77553b0432818d3890b8d6c96fb4d0dcb605f216c91e2f0a056954e2821f20ee837f8b6a985`,
      `hex`,
    ),
  },
  {
    version: 20250311122808,
    description: `provider_config`,
    sql: "ALTER TABLE `provider` ADD `config` text;",
    checksum: Buffer.from(
      `d56019d6daa1c207dfd402788d8ad3b8758ccf492f9263fe896fccbb958331b6df4bf98142e78d0853c35eaee2c4444f`,
      `hex`,
    ),
  },
  {
    version: 20250315182322,
    description: `mcp`,
    sql: "CREATE TABLE `tool` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`createdAt` integer NOT NULL,\n\t`updatedAt` integer,\n\t`displayId` text NOT NULL,\n\t`config` text NOT NULL,\n\t`enabled` integer,\n\t`autoRun` integer\n);\n--> statement-breakpoint\nCREATE UNIQUE INDEX `tool_displayId_unique` ON `tool` (`displayId`);--> statement-breakpoint\nALTER TABLE `assistant` ADD `toolEnabled` integer;--> statement-breakpoint\nALTER TABLE `assistant` ADD `toolIds` text;--> statement-breakpoint\nALTER TABLE `chat` ADD `toolEnabled` integer;--> statement-breakpoint\nALTER TABLE `chat` ADD `toolIds` text;",
    checksum: Buffer.from(
      `85773805262607f6ca03c403b4042ebc6ec8311363ceab3fbeaf1feef21bb6d8564d4fb2fc512c79c3dd6e7d44a3d663`,
      `hex`,
    ),
  },
  {
    version: 20250416092708,
    description: `generated_files`,
    sql: "ALTER TABLE `message` ADD `generatedFiles` text;--> statement-breakpoint\nCREATE INDEX `message_generatedFiles_idx` ON `message` (`generatedFiles`);\n\nUPDATE `message` \nSET `generatedFiles` = json_extract(`meta`, '$.generatedFiles');",
    checksum: Buffer.from(
      `c28b55c54ebabd20f146a67c8d2325cd421451b2420c0d19db079b0b312c4a0199310a3f554bab409b18d47b97b8e6c6`,
      `hex`,
    ),
  },
  {
    version: 20250424191207,
    description: `image_gen`,
    sql: "ALTER TABLE `assistant` ADD `imageGenEnabled` integer;--> statement-breakpoint\nALTER TABLE `assistant` ADD `imageGenOptions` text;--> statement-breakpoint\nALTER TABLE `chat` ADD `imageGenEnabled` integer;--> statement-breakpoint\nALTER TABLE `chat` ADD `imageGenOptions` text;",
    checksum: Buffer.from(
      `c2c9e8dbd8c1d4acd52e9f10c59172645ec1b4099d6eff4b3715b40a5dd00598388edf6c61f506ed426db44c499d6b5c`,
      `hex`,
    ),
  },
  {
    version: 20250616150932,
    description: `provider_icon`,
    sql: "ALTER TABLE `provider` ADD `icon` text;",
    checksum: Buffer.from(
      `1ef227ae90c18b3a47ef52843d30bfc4d93143a29877c13163034e1fab0e5e3410decc659d125b42d30b2c6effe8861e`,
      `hex`,
    ),
  },
  {
    version: 20250717101450,
    description: `web_search_options`,
    sql: "ALTER TABLE `assistant` ADD `webSearchOptions` text;--> statement-breakpoint\nALTER TABLE `chat` ADD `webSearchOptions` text;",
    checksum: Buffer.from(
      `ace25b4898eee27ab5244563524dca72cc5418cf52a02a962fa2e1b29a02eb9bd4860a001e7413821ea9686fbe3ad17f`,
      `hex`,
    ),
  },
  {
    version: 20250727110027,
    description: `prompt_model`,
    sql: "ALTER TABLE `prompt` ADD `model` text;",
    checksum: Buffer.from(
      `bc6a992e5b4ec872d2aa927a018a48b8b28c0b97ce701916a3c7c8555f4044d0930037324cc7bfe7c5dc9725430d337b`,
      `hex`,
    ),
  },
  {
    version: 20250812144129,
    description: `exclude_tools`,
    sql: "ALTER TABLE `tool` ADD `excludedTools` text;",
    checksum: Buffer.from(
      `bd88a191532b4986bdd650dc25472d62e300155df67ddedbbd2b7b207e943a034da409aea74d896c9cf437e50a09fc65`,
      `hex`,
    ),
  },
  {
    version: 20250813115748,
    description: `mcp_oauth`,
    sql: "ALTER TABLE `tool` ADD `oauthClient` text;--> statement-breakpoint\nALTER TABLE `tool` ADD `oauthTokens` text;",
    checksum: Buffer.from(
      `40b45030d7412e46c6cf298768034ec27931955b21ccf566e82d9db9b7def8f1ce7851a36e7130bea3ec28c834a9cdcc`,
      `hex`,
    ),
  },
  {
    version: 20250814080059,
    description: `mcp_lastfetched_tools`,
    sql: "ALTER TABLE `tool` ADD `lastFetchedTools` text;",
    checksum: Buffer.from(
      `4fb3dc56b721bd7df5657c88b6c46a3d2bc67d1bb016b9744ac637a59e74e5d3023618b2fcc0a1a33c0eac48d0cf88fa`,
      `hex`,
    ),
  },
  {
    version: 20250905154949,
    description: `chat_meta`,
    sql: "ALTER TABLE `chat` ADD `meta` text;",
    checksum: Buffer.from(
      `e1d6714e63afbca59cb268605a48d473cbaa4ded0cb1ad10f985aacc13dfb289262c614b88a5f8ec6f8b55b3dc651239`,
      `hex`,
    ),
  },
  {
    version: 20250914164243,
    description: `mcp_display_name`,
    sql: "ALTER TABLE `tool` ADD `displayName` text;",
    checksum: Buffer.from(
      `bec232048e7adf926907043bfce4e7905e7f0161099f94e25237bd5eb4d5118306d61007b80c1c4ce668d8f8c67b98d4`,
      `hex`,
    ),
  },
  {
    version: 20260226090029,
    description: `agent_mode`,
    sql: "ALTER TABLE `assistant` ADD `agentModeEnabled` integer;--> statement-breakpoint\nALTER TABLE `assistant` ADD `agentOptions` text;--> statement-breakpoint\nALTER TABLE `chat` ADD `agentModeEnabled` integer;--> statement-breakpoint\nALTER TABLE `chat` ADD `agentOptions` text;",
    checksum: Buffer.from(
      `bd99feb356c4b0164057de3e31ba7d516f58ccf55de5a5335cf5cf557d1b82616fa961e719274bda6bfa63ac8470c78e`,
      `hex`,
    ),
  },
];
let Wn;
const Gn = `_sqlx_migrations`;
async function Kn() {
  return (
    Wn ||
    ((Wn = qn().catch((e) => {
      Wn = undefined;
      throw e;
    })),
    Wn)
  );
}
async function qn() {
  let e = er();
  if (!F.existsSync(e)) {
    F.mkdirSync(e, {
      recursive: true,
    });
  }
  await Zn(e);
  let t = new J(v.join(e, `app.db`));
  t.pragma(`journal_mode = WAL`);
  try {
    Jn(t);
  } catch (e) {
    t.close();
    throw e;
  }
  return t;
}
function Jn(e) {
  e.exec(`
    CREATE TABLE IF NOT EXISTS ${Gn} (
      version BIGINT PRIMARY KEY,
      description TEXT NOT NULL,
      installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      success BOOLEAN NOT NULL,
      checksum BLOB NOT NULL,
      execution_time BIGINT NOT NULL
    )
  `);
  let t = Yn(e);
  if (t !== undefined) {
    throw Error(`Database migration ${t} is dirty`);
  }
  let n = Xn(e);
  let r = new Set(Un.map((e) => e.version));
  for (let e of n) {
    if (!r.has(e.version)) {
      throw Error(`Applied migration ${e.version} is missing from migrations`);
    }
  }
  let i = new Map(n.map((e) => [e.version, e.checksum]));
  for (let t of Un) {
    let n = i.get(t.version);
    if (n) {
      if (!n.equals(t.checksum)) {
        throw Error(`Migration ${t.version} checksum mismatch`);
      }
      continue;
    }
    let r = process.hrtime.bigint();
    e.transaction(() => {
      e.exec(t.sql);
      e.prepare(
        `
          INSERT INTO ${Gn}
            (version, description, success, checksum, execution_time)
          VALUES (?, ?, TRUE, ?, -1)
        `,
      ).run(t.version, t.description, t.checksum);
    })();
    let a = Number(process.hrtime.bigint() - r);
    e.prepare(
      `
        UPDATE ${Gn}
        SET execution_time = ?
        WHERE version = ?
      `,
    ).run(a, t.version);
  }
}
function Yn(e) {
  let t = e
    .prepare(
      `
    SELECT version
    FROM ${Gn}
    WHERE success = FALSE
    ORDER BY version
    LIMIT 1
  `,
    )
    .get()?.version;
  if (typeof t == `number`) {
    return t;
  } else if (t == null) {
    return undefined;
  } else {
    return Number(t);
  }
}
function Xn(e) {
  return e
    .prepare(
      `
    SELECT version, checksum
    FROM ${Gn}
    ORDER BY version
  `,
    )
    .all()
    .map((e) => ({
      version: typeof e.version == `number` ? e.version : Number(e.version),
      checksum: $n(e.checksum),
    }));
}
async function Zn(e) {
  let t = v.join(e, `app.db`);
  if (!F.existsSync(t)) {
    return;
  }
  let n = v.join(e, `backups`);
  await F.promises.mkdir(n, {
    recursive: true,
  });
  let r = v.join(n, `meta.json`);
  let i = 0;
  if (F.existsSync(r)) {
    try {
      i = JSON.parse(await F.promises.readFile(r, `utf-8`)).lastBackupAt ?? 0;
    } catch {}
  }
  let a = Date.now();
  if (a - i < 3600000) {
    return;
  }
  let o = `app-${new Date().toISOString().slice(0, 10)}.db`;
  let s = v.join(n, o);
  await F.promises.copyFile(t, s);
  await F.promises.writeFile(
    r,
    JSON.stringify({
      lastBackupAt: a,
    }),
  );
  let c = await Promise.all(
    (
      await F.promises.readdir(n, {
        withFileTypes: true,
      })
    )
      .filter((e) => e.isFile())
      .map(async (e) => {
        if (!e.name.startsWith(`app-`) || v.extname(e.name) !== `.db`) {
          return;
        }
        let t = v.join(n, e.name);
        return {
          path: t,
          modifiedAt: (await F.promises.stat(t)).mtimeMs,
        };
      }),
  );
  for (let e of c
    .filter((e) => e !== undefined)
    .sort((e, t) => t.modifiedAt - e.modifiedAt)
    .slice(7)) {
    try {
      await F.promises.unlink(e.path);
    } catch {}
  }
}
async function Qn() {
  await Zn(er());
}
function $n(e) {
  if (Buffer.isBuffer(e)) {
    return e;
  }
  if (e instanceof Uint8Array || e instanceof ArrayBuffer) {
    return Buffer.from(e);
  }
  throw Error(`Unexpected checksum value returned from database`);
}
function er() {
  return bn;
}
function tr(e) {
  let t = () => {
    let t = e.isFullScreen();
    Z(e.webContents).fullscreenChanged.send(t);
  };
  e.on(`enter-full-screen`, t);
  e.on(`leave-full-screen`, t);
}
function nr(e) {
  let t = () => {
    Z(e.webContents).navigationStateChanged.send({
      canGoBack: e.webContents.navigationHistory.canGoBack(),
      canGoForward: e.webContents.navigationHistory.canGoForward(),
    });
  };
  e.webContents.on(`did-navigate`, t);
  e.webContents.on(`did-navigate-in-page`, t);
}
const rr = new Map();
const ir = {
  value: false,
};
function ar() {
  if (rr.size === 0) {
    return true;
  }
  for (let e of rr.values()) {
    if (e.isVisible()) {
      return false;
    }
  }
  return true;
}
function or(e) {
  let t = new n({
    width: 1080,
    height: 870,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: `hiddenInset`,
    trafficLightPosition: {
      x: 14,
      y: 18,
    },
    ...e.windowOptions,
    webPreferences: {
      preload: L.join(import.meta.dirname, `./preload.js`),
      ...e.windowOptions?.webPreferences,
    },
  });
  if (process.env.CHATWISE_DEV_MENU) {
    t.webContents.on(`context-menu`, () => {
      t.webContents.openDevTools();
    });
  }
  let r = e.type === `settings` ? e.type : `${e.type}:${Date.now()}`;
  rr.set(r, t);
  Dn(t);
  tr(t);
  nr(t);
  e.onCreated?.(t);
  t.on(`show`, () => {
    Bn(true);
    Qn().catch(console.error);
  });
  t.on(`close`, (n) => {
    if (e.hideOnClose && !ir.value) {
      n.preventDefault();
      t.hide();
    }
    if (ar()) {
      Bn(false);
    }
  });
  t.on(`closed`, () => {
    rr.delete(r);
  });
  t.webContents.setWindowOpenHandler((e) => {
    g.openExternal(e.url);
    return {
      action: `deny`,
    };
  });
  let i = e.url.replace(/^\/?/, `/`);
  t.loadURL(`client://app${i}`);
  return t;
}
function sr() {
  return or({
    type: `main`,
    url: `/`,
    hideOnClose: true,
    onCreated(e) {
      jn(e);
    },
  });
}
function cr(e = `/settings`) {
  let t = rr.get(`settings`);
  let r = (t) => {
    Z(t.webContents).navigate.send(e);
  };
  if (t) {
    t.show();
    r(t);
  } else {
    t = or({
      type: `settings`,
      url: e,
      windowOptions: {
        width: 900,
        height: 600,
        trafficLightPosition: {
          x: 18,
          y: 18,
        },
        fullscreenable: false,
      },
      onCreated(e) {
        let t = e.id;
        d.once(`windowReady`, (e) => {
          let i = n.fromWebContents(e.sender);
          if (i && i.id === t) {
            r(i);
          }
        });
      },
    });
    return t;
  }
}
function lr(e) {
  return [...rr.entries()]
    .filter(([t, n]) => t === e || t.startsWith(`${e}:`))
    .map(([e, t]) => t);
}
function ur() {
  let e = lr(`main`);
  if (e.length === 0) {
    sr();
  } else {
    e.forEach((e) => {
      e.show();
    });
  }
}
var dr = Object.create;
var fr = Object.defineProperty;
var pr = Object.getOwnPropertyDescriptor;
var mr = Object.getOwnPropertyNames;
var hr = Object.getPrototypeOf;
var gr = Object.prototype.hasOwnProperty;
var _r = (e, t) => () => {
  if (!t) {
    e(
      (t = {
        exports: {},
      }).exports,
      t,
    );
  }
  return t.exports;
};
var vr = (e, t, n, r) => {
  if ((t && typeof t == `object`) || typeof t == `function`) {
    var i = mr(t);
    for (var a = 0, o = i.length, s; a < o; a++) {
      s = i[a];
      if (!gr.call(e, s) && s !== n) {
        fr(e, s, {
          get: ((e) => t[e]).bind(null, s),
          enumerable: !(r = pr(t, s)) || r.enumerable,
        });
      }
    }
  }
  return e;
};
var yr = (e, t, n) => {
  n = e == null ? {} : dr(hr(e));
  return vr(
    t || !e || !e.__esModule
      ? fr(n, `default`, {
          value: e,
          enumerable: true,
        })
      : n,
    e,
  );
};
var br = q(import.meta.url);
const xr = /^path$/i;
const Sr = {
  key: `PATH`,
  value: ``,
};
function Cr(e) {
  for (let t in e) {
    if (!Object.prototype.hasOwnProperty.call(e, t) || !xr.test(t)) {
      continue;
    }
    let n = e[t];
    if (n) {
      return {
        key: t,
        value: n,
      };
    } else {
      return Sr;
    }
  }
  return Sr;
}
function wr(e, t) {
  let n = t.value.split(R);
  let r = e;
  let i;
  do {
    n.push(H(r, `node_modules`, `.bin`));
    i = r;
    r = z(r);
  } while (r !== i);
  return {
    key: t.key,
    value: n.join(R),
  };
}
function Tr(e, t) {
  let n = {
    ...process.env,
    ...t,
  };
  let r = wr(e, Cr(n));
  n[r.key] = r.value;
  return n;
}
const Er = (e) => {
  let t = e.length;
  let n = new re();
  let r = () => {
    if (--t === 0) {
      n.emit(`end`);
    }
  };
  for (let t of e) {
    t.pipe(n, {
      end: false,
    });
    t.on(`end`, r);
  }
  return n;
};
var Dr = _r((e, t) => {
  t.exports = a;
  a.sync = o;
  var n = br(`fs`);
  function r(e, t) {
    var n = t.pathExt === undefined ? process.env.PATHEXT : t.pathExt;
    if (!n || ((n = n.split(`;`)), n.indexOf(``) !== -1)) {
      return true;
    }
    for (var r = 0; r < n.length; r++) {
      var i = n[r].toLowerCase();
      if (i && e.substr(-i.length).toLowerCase() === i) {
        return true;
      }
    }
    return false;
  }
  function i(e, t, n) {
    if (!e.isSymbolicLink() && !e.isFile()) {
      return false;
    } else {
      return r(t, n);
    }
  }
  function a(e, t, r) {
    n.stat(e, function (n, a) {
      r(n, n ? false : i(a, e, t));
    });
  }
  function o(e, t) {
    return i(n.statSync(e), e, t);
  }
});
var Or = _r((e, t) => {
  t.exports = r;
  r.sync = i;
  var n = br(`fs`);
  function r(e, t, r) {
    n.stat(e, function (e, n) {
      r(e, e ? false : a(n, t));
    });
  }
  function i(e, t) {
    return a(n.statSync(e), t);
  }
  function a(e, t) {
    return e.isFile() && o(e, t);
  }
  function o(e, t) {
    var n = e.mode;
    var r = e.uid;
    var i = e.gid;
    var a = t.uid === undefined ? process.getuid && process.getuid() : t.uid;
    var o = t.gid === undefined ? process.getgid && process.getgid() : t.gid;
    var s = 64;
    var c = 8;
    var l = 1;
    var u = s | c;
    return (
      n & l || (n & c && i === o) || (n & s && r === a) || (n & u && a === 0)
    );
  }
});
var kr = _r((e, t) => {
  br(`fs`);
  var n = process.platform === `win32` || global.TESTING_WINDOWS ? Dr() : Or();
  t.exports = r;
  r.sync = i;
  function r(e, t, i) {
    if (typeof t == `function`) {
      i = t;
      t = {};
    }
    if (!i) {
      if (typeof Promise != `function`) {
        throw TypeError(`callback not provided`);
      }
      return new Promise(function (n, i) {
        r(e, t || {}, function (e, t) {
          if (e) {
            i(e);
          } else {
            n(t);
          }
        });
      });
    }
    n(e, t || {}, function (e, n) {
      if (e && (e.code === `EACCES` || (t && t.ignoreErrors))) {
        e = null;
        n = false;
      }
      i(e, n);
    });
  }
  function i(e, t) {
    try {
      return n.sync(e, t || {});
    } catch (e) {
      if ((t && t.ignoreErrors) || e.code === `EACCES`) {
        return false;
      }
      throw e;
    }
  }
});
var Ar = _r((e, t) => {
  let n =
    process.platform === `win32` ||
    process.env.OSTYPE === `cygwin` ||
    process.env.OSTYPE === `msys`;
  let r = br(`path`);
  let i = n ? `;` : `:`;
  let a = kr();
  let o = (e) =>
    Object.assign(Error(`not found: ${e}`), {
      code: `ENOENT`,
    });
  let s = (e, t) => {
    let r = t.colon || i;
    let a =
      e.match(/\//) || (n && e.match(/\\/))
        ? [``]
        : [
            ...(n ? [process.cwd()] : []),
            ...(t.path || process.env.PATH || ``).split(r),
          ];
    let o = n ? t.pathExt || process.env.PATHEXT || `.EXE;.CMD;.BAT;.COM` : ``;
    let s = n ? o.split(r) : [``];
    if (n && e.indexOf(`.`) !== -1 && s[0] !== ``) {
      s.unshift(``);
    }
    return {
      pathEnv: a,
      pathExt: s,
      pathExtExe: o,
    };
  };
  let c = (e, t, n) => {
    if (typeof t == `function`) {
      n = t;
      t = {};
    }
    t ||= {};
    let { pathEnv: i, pathExt: c, pathExtExe: l } = s(e, t);
    let u = [];
    let d = (n) =>
      new Promise((a, s) => {
        if (n === i.length) {
          if (t.all && u.length) {
            return a(u);
          } else {
            return s(o(e));
          }
        }
        let c = i[n];
        let l = /^".*"$/.test(c) ? c.slice(1, -1) : c;
        let d = r.join(l, e);
        a(f(!l && /^\.[\\\/]/.test(e) ? e.slice(0, 2) + d : d, n, 0));
      });
    let f = (e, n, r) =>
      new Promise((i, o) => {
        if (r === c.length) {
          return i(d(n + 1));
        }
        let s = c[r];
        a(
          e + s,
          {
            pathExt: l,
          },
          (a, o) => {
            if (!a && o) {
              if (t.all) {
                u.push(e + s);
              } else {
                return i(e + s);
              }
            }
            return i(f(e, n, r + 1));
          },
        );
      });
    if (n) {
      return d(0).then((e) => n(null, e), n);
    } else {
      return d(0);
    }
  };
  t.exports = c;
  c.sync = (e, t) => {
    t ||= {};
    let { pathEnv: n, pathExt: i, pathExtExe: c } = s(e, t);
    let l = [];
    for (let o = 0; o < n.length; o++) {
      let s = n[o];
      let u = /^".*"$/.test(s) ? s.slice(1, -1) : s;
      let d = r.join(u, e);
      let f = !u && /^\.[\\\/]/.test(e) ? e.slice(0, 2) + d : d;
      for (let e = 0; e < i.length; e++) {
        let n = f + i[e];
        try {
          if (
            a.sync(n, {
              pathExt: c,
            })
          ) {
            if (t.all) {
              l.push(n);
            } else {
              return n;
            }
          }
        } catch {}
      }
    }
    if (t.all && l.length) {
      return l;
    }
    if (t.nothrow) {
      return null;
    }
    throw o(e);
  };
});
var jr = _r((e, t) => {
  let n = (e = {}) => {
    let t = e.env || process.env;
    if ((e.platform || process.platform) === `win32`) {
      return (
        Object.keys(t)
          .reverse()
          .find((e) => e.toUpperCase() === `PATH`) || `Path`
      );
    } else {
      return `PATH`;
    }
  };
  t.exports = n;
  t.exports.default = n;
});
var Mr = _r((e, t) => {
  let n = br(`path`);
  let r = Ar();
  let i = jr();
  function a(e, t) {
    let a = e.options.env || process.env;
    let o = process.cwd();
    let s = e.options.cwd != null;
    let c = s && process.chdir !== undefined && !process.chdir.disabled;
    if (c) {
      try {
        process.chdir(e.options.cwd);
      } catch {}
    }
    let l;
    try {
      l = r.sync(e.command, {
        path: a[
          i({
            env: a,
          })
        ],
        pathExt: t ? n.delimiter : undefined,
      });
    } catch {
    } finally {
      if (c) {
        process.chdir(o);
      }
    }
    l &&= n.resolve(s ? e.options.cwd : ``, l);
    return l;
  }
  function o(e) {
    return a(e) || a(e, true);
  }
  t.exports = o;
});
var Nr = _r((e, t) => {
  let n = /([()\][%!^"`<>&|;, *?])/g;
  function r(e) {
    e = e.replace(n, `^$1`);
    return e;
  }
  function i(e, t) {
    e = `${e}`;
    e = e.replace(/(\\*)"/g, `$1$1\\"`);
    e = e.replace(/(\\*)$/, `$1$1`);
    e = `"${e}"`;
    e = e.replace(n, `^$1`);
    if (t) {
      e = e.replace(n, `^$1`);
    }
    return e;
  }
  t.exports.command = r;
  t.exports.argument = i;
});
var Pr = _r((e, t) => {
  t.exports = /^#!(.*)/;
});
var Fr = _r((e, t) => {
  let n = Pr();
  t.exports = (e = ``) => {
    let t = e.match(n);
    if (!t) {
      return null;
    }
    let [r, i] = t[0].replace(/#! ?/, ``).split(` `);
    let a = r.split(`/`).pop();
    if (a === `env`) {
      return i;
    } else if (i) {
      return `${a} ${i}`;
    } else {
      return a;
    }
  };
});
var Ir = _r((e, t) => {
  let n = br(`fs`);
  let r = Fr();
  function i(e) {
    let t = Buffer.alloc(150);
    let i;
    try {
      i = n.openSync(e, `r`);
      n.readSync(i, t, 0, 150, 0);
      n.closeSync(i);
    } catch {}
    return r(t.toString());
  }
  t.exports = i;
});
var Lr = _r((e, t) => {
  let n = br(`path`);
  let r = Mr();
  let i = Nr();
  let a = Ir();
  let o = process.platform === `win32`;
  let s = /\.(?:com|exe)$/i;
  let c = /node_modules[\\/].bin[\\/][^\\/]+\.cmd$/i;
  function l(e) {
    e.file = r(e);
    let t = e.file && a(e.file);
    if (t) {
      e.args.unshift(e.file);
      e.command = t;
      return r(e);
    } else {
      return e.file;
    }
  }
  function u(e) {
    if (!o) {
      return e;
    }
    let t = l(e);
    let r = !s.test(t);
    if (e.options.forceShell || r) {
      let r = c.test(t);
      e.command = n.normalize(e.command);
      e.command = i.command(e.command);
      e.args = e.args.map((e) => i.argument(e, r));
      e.args = [`/d`, `/s`, `/c`, `"${[e.command].concat(e.args).join(` `)}"`];
      e.command = process.env.comspec || `cmd.exe`;
      e.options.windowsVerbatimArguments = true;
    }
    return e;
  }
  function d(e, t, n) {
    if (t && !Array.isArray(t)) {
      n = t;
      t = null;
    }
    t = t ? t.slice(0) : [];
    n = Object.assign({}, n);
    let r = {
      command: e,
      args: t,
      options: n,
      file: undefined,
      original: {
        command: e,
        args: t,
      },
    };
    if (n.shell) {
      return r;
    } else {
      return u(r);
    }
  }
  t.exports = d;
});
var Rr = _r((e, t) => {
  let n = process.platform === `win32`;
  function r(e, t) {
    return Object.assign(Error(`${t} ${e.command} ENOENT`), {
      code: `ENOENT`,
      errno: `ENOENT`,
      syscall: `${t} ${e.command}`,
      path: e.command,
      spawnargs: e.args,
    });
  }
  function i(e, t) {
    if (!n) {
      return;
    }
    let r = e.emit;
    e.emit = function (n, i) {
      if (n === `exit`) {
        let n = a(i, t, `spawn`);
        if (n) {
          return r.call(e, `error`, n);
        }
      }
      return r.apply(e, arguments);
    };
  }
  function a(e, t) {
    if (n && e === 1 && !t.file) {
      return r(t.original, `spawn`);
    } else {
      return null;
    }
  }
  function o(e, t) {
    if (n && e === 1 && !t.file) {
      return r(t.original, `spawnSync`);
    } else {
      return null;
    }
  }
  t.exports = {
    hookChildProcess: i,
    verifyENOENT: a,
    verifyENOENTSync: o,
    notFoundError: r,
  };
});
var zr = yr(
  _r((e, t) => {
    let n = br(`child_process`);
    let r = Lr();
    let i = Rr();
    function a(e, t, a) {
      let o = r(e, t, a);
      let s = n.spawn(o.command, o.args, o.options);
      i.hookChildProcess(s, o);
      return s;
    }
    function o(e, t, a) {
      let o = r(e, t, a);
      let s = n.spawnSync(o.command, o.args, o.options);
      s.error = s.error || i.verifyENOENTSync(s.status, o);
      return s;
    }
    t.exports = a;
    t.exports.spawn = a;
    t.exports.sync = o;
    t.exports._parse = r;
    t.exports._enoent = i;
  })(),
  1,
);
var Br = class extends Error {
  result;
  output;
  get exitCode() {
    if (this.result.exitCode !== null) {
      return this.result.exitCode;
    }
  }
  constructor(e, t) {
    super(`Process exited with non-zero status (${e.exitCode})`);
    this.result = e;
    this.output = t;
  }
};
const Vr = {
  timeout: undefined,
  persist: false,
};
const Hr = {
  windowsHide: true,
};
function Ur(e, t) {
  return {
    command: V(e),
    args: t ?? [],
  };
}
function Wr(e) {
  let t = new AbortController();
  for (let n of e) {
    if (n.aborted) {
      t.abort();
      return n;
    }
    n.addEventListener(
      `abort`,
      () => {
        t.abort(n.reason);
      },
      {
        signal: t.signal,
      },
    );
  }
  return t.signal;
}
async function Gr(e) {
  let t = ``;
  for await (let n of e) {
    t += n.toString();
  }
  return t;
}
var Kr = class {
  _process;
  _aborted = false;
  _options;
  _command;
  _args;
  _resolveClose;
  _processClosed;
  _thrownError;
  get process() {
    return this._process;
  }
  get pid() {
    return this._process?.pid;
  }
  get exitCode() {
    if (this._process && this._process.exitCode !== null) {
      return this._process.exitCode;
    }
  }
  constructor(e, t, n) {
    this._options = {
      ...Vr,
      ...n,
    };
    this._command = e;
    this._args = t ?? [];
    this._processClosed = new Promise((e) => {
      this._resolveClose = e;
    });
  }
  kill(e) {
    return this._process?.kill(e) === true;
  }
  get aborted() {
    return this._aborted;
  }
  get killed() {
    return this._process?.killed === true;
  }
  pipe(e, t, n) {
    return Q(e, t, {
      ...n,
      stdin: this,
    });
  }
  async *[Symbol.asyncIterator]() {
    let e = this._process;
    if (!e) {
      return;
    }
    let t = [];
    if (this._streamErr) {
      t.push(this._streamErr);
    }
    if (this._streamOut) {
      t.push(this._streamOut);
    }
    let n = Er(t);
    let r = ie.createInterface({
      input: n,
    });
    for await (let e of r) {
      yield e.toString();
    }
    await this._processClosed;
    e.removeAllListeners();
    if (this._thrownError) {
      throw this._thrownError;
    }
    if (
      this._options?.throwOnError &&
      this.exitCode !== 0 &&
      this.exitCode !== undefined
    ) {
      throw new Br(this);
    }
  }
  async _waitForOutput() {
    let e = this._process;
    if (!e) {
      throw Error(`No process was started`);
    }
    let [t, n] = await Promise.all([
      this._streamOut ? Gr(this._streamOut) : ``,
      this._streamErr ? Gr(this._streamErr) : ``,
    ]);
    await this._processClosed;
    if (this._options?.stdin) {
      await this._options.stdin;
    }
    e.removeAllListeners();
    if (this._thrownError) {
      throw this._thrownError;
    }
    let r = {
      stderr: n,
      stdout: t,
      exitCode: this.exitCode,
    };
    if (
      this._options.throwOnError &&
      this.exitCode !== 0 &&
      this.exitCode !== undefined
    ) {
      throw new Br(this, r);
    }
    return r;
  }
  then(e, t) {
    return this._waitForOutput().then(e, t);
  }
  _streamOut;
  _streamErr;
  spawn() {
    let e = Y();
    let t = this._options;
    let n = {
      ...Hr,
      ...t.nodeOptions,
    };
    let r = [];
    this._resetState();
    if (t.timeout !== undefined) {
      r.push(AbortSignal.timeout(t.timeout));
    }
    if (t.signal !== undefined) {
      r.push(t.signal);
    }
    if (t.persist === true) {
      n.detached = true;
    }
    if (r.length > 0) {
      n.signal = Wr(r);
    }
    n.env = Tr(e, n.env);
    let { command: i, args: a } = Ur(this._command, this._args);
    let o = (0, zr._parse)(i, a, n);
    let s = D(o.command, o.args, o.options);
    if (s.stderr) {
      this._streamErr = s.stderr;
    }
    if (s.stdout) {
      this._streamOut = s.stdout;
    }
    this._process = s;
    s.once(`error`, this._onError);
    s.once(`close`, this._onClose);
    if (t.stdin !== undefined && s.stdin && t.stdin.process) {
      let { stdout: e } = t.stdin.process;
      if (e) {
        e.pipe(s.stdin);
      }
    }
  }
  _resetState() {
    this._aborted = false;
    this._processClosed = new Promise((e) => {
      this._resolveClose = e;
    });
    this._thrownError = undefined;
  }
  _onError = (e) => {
    if (
      e.name === `AbortError` &&
      (!(e.cause instanceof Error) || e.cause.name !== `TimeoutError`)
    ) {
      this._aborted = true;
      return;
    }
    this._thrownError = e;
  };
  _onClose = () => {
    if (this._resolveClose) {
      this._resolveClose();
    }
  };
};
const Q = (e, t, n) => {
  let r = new Kr(e, t, n);
  r.spawn();
  return r;
};
function qr(e, t = {}) {
  let n = {};
  let r = e.trim().split(`
`);
  let i = 0;
  while (i < r.length) {
    let e = r[i].trim();
    if (e.startsWith(`#`) || !e.includes(`=`)) {
      i++;
      continue;
    }
    let a = e.indexOf(`=`);
    let o = e.substring(0, a).trim();
    let s = e.substring(a + 1).trim();
    if (o && !o.includes(` `)) {
      let e = s.startsWith(`"`) || s.startsWith(`'`);
      let a = e ? s[0] : null;
      if (e && a) {
        s = s.substring(1);
        if (s.endsWith(a)) {
          s = s.substring(0, s.length - 1);
        } else {
          let e = [s];
          for (i++; i < r.length; ) {
            let t = r[i];
            if (t.endsWith(a)) {
              e.push(t.substring(0, t.length - 1));
              break;
            } else {
              e.push(t);
            }
            i++;
          }
          s = e.join(`
`);
        }
      } else {
        s = s.replace(/['"]$/, ``);
      }
      s = Jr(s, t);
      n[o] = s;
    }
    i++;
  }
  return n;
}
function Jr(e, t) {
  if (Object.keys(t).length > 0) {
    return e.replace(/\$([A-Z0-9\-\_]+)/g, (e, n) => t[n] || e);
  } else {
    return e;
  }
}
function Yr() {
  return process.env.SHELL || `/bin/zsh`;
}
let Xr;
async function Zr() {
  return Xr || ((Xr = Qr()), Xr);
}
async function Qr() {
  try {
    let { stdout: e } = await Q(
      Yr(),
      [
        `-ilc`,
        `echo -n "_SHELL_ENV_DELIMITER_"; command env; echo -n "_SHELL_ENV_DELIMITER_"; exit`,
      ],
      {
        throwOnError: true,
        nodeOptions: {
          env: {
            DISABLE_AUTO_UPDATE: `true`,
            ZSH_TMUX_AUTOSTARTED: `true`,
            ZSH_TMUX_AUTOSTART: `false`,
          },
        },
      },
    );
    return qr(e.trim().split(`_SHELL_ENV_DELIMITER_`)[1]);
  } catch {
    return {};
  }
}
function $r(e, t = 16000) {
  let n = e.length * 2;
  let r = Buffer.alloc(44 + n);
  r.write(`RIFF`, 0);
  r.writeUInt32LE(36 + n, 4);
  r.write(`WAVE`, 8);
  r.write(`fmt `, 12);
  r.writeUInt32LE(16, 16);
  r.writeUInt16LE(1, 20);
  r.writeUInt16LE(1, 22);
  r.writeUInt32LE(t, 24);
  r.writeUInt32LE(t * 2, 28);
  r.writeUInt16LE(2, 32);
  r.writeUInt16LE(16, 34);
  r.write(`data`, 36);
  r.writeUInt32LE(n, 40);
  for (let [t, n] of e.entries()) {
    let e = Math.max(-32768, Math.min(32767, Math.round(n)));
    r.writeInt16LE(e, 44 + t * 2);
  }
  return r;
}
async function ei(e, t) {
  let n = L.join(bn, `files`);
  let r = L.join(n, e);
  await A(n, {
    recursive: true,
  });
  await N(r, $r(t));
  return r;
}
async function ti(e, t) {
  if (process.platform === `win32`) {
    await Q(`cmd`, [`/c`, `tar`, `-a`, `-c`, `-f`, t, `*`], {
      throwOnError: true,
      nodeOptions: {
        cwd: e,
      },
    });
    return;
  }
  await Q(`zip`, [`-r`, t, `.`], {
    throwOnError: true,
    nodeOptions: {
      cwd: e,
    },
  });
}
async function ni(e, t) {
  if (process.platform === `win32`) {
    await Q(`cmd`, [`/c`, `tar`, `-xf`, e, `-C`, t], {
      throwOnError: true,
    });
    return;
  }
  await Q(`unzip`, [`-o`, e, `-d`, t], {
    throwOnError: true,
  });
}
async function ri(e) {
  let t = e.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!t) {
    return {};
  }
  let { parse: n } = await import(`./browser-De0YiaQ9.js`);
  try {
    let e = n(t[1]);
    if (!e || typeof e != `object`) {
      return {};
    }
    let r = e;
    return {
      name: typeof r.name == `string` ? r.name : undefined,
      description: typeof r.description == `string` ? r.description : undefined,
    };
  } catch (e) {
    console.error(e);
    return {};
  }
}
function ii() {
  switch (process.platform) {
    case `darwin`:
    case `linux`:
      return `pngquant`;
    case `win32`:
      return `pngquant.exe`;
    default:
      throw Error(`Unsupported platform: ${process.platform}`);
  }
}
function ai() {
  switch (process.platform) {
    case `darwin`:
      return `https://bin.chatwise.app/pngquant/pngquant-darwin`;
    case `win32`:
      return `https://bin.chatwise.app/pngquant/pngquant.exe`;
    case `linux`:
      return `https://bin.chatwise.app/pngquant/pngquant-linux`;
    default:
      throw Error(`Unsupported platform: ${process.platform}`);
  }
}
function oi() {
  let e = c.isPackaged
    ? L.join(bn, `bin`)
    : L.join(process.cwd(), `temp`, `bin`);
  return L.join(e, ii());
}
async function si() {
  let e = oi();
  if (F.existsSync(e)) {
    return e;
  }
  await A(L.dirname(e), {
    recursive: true,
  });
  let t = await fetch(ai());
  if (!t.ok) {
    throw Error(`Failed to download pngquant: HTTP ${t.status}`);
  }
  let n = await t.arrayBuffer();
  await N(e, Buffer.from(n));
  if (process.platform !== `win32`) {
    await k(e, 493);
  }
  return e;
}
async function ci(e, t) {
  let n = await si();
  try {
    await Q(n, [`--force`, `-o`, t, e], {
      throwOnError: true,
    });
  } catch (e) {
    let t = e instanceof Error && `stderr` in e ? String(e.stderr) : ``;
    throw Error(`pngquant failed${t ? `: ${t}` : ``}`);
  }
}
function li(e) {
  let t = process.platform;
  let n = process.arch;
  if (e === `bun`) {
    if (t === `darwin` && n === `x64`) {
      return `https://bin.chatwise.app/bun-darwin-x64.zip`;
    }
    if (t === `darwin` && n === `arm64`) {
      return `https://bin.chatwise.app/bun-darwin-aarch64.zip`;
    }
    if ((t === `win32` && n === `x64`) || (t === `win32` && n === `arm64`)) {
      return `https://bin.chatwise.app/bun-windows-x64.zip`;
    }
    if (t === `linux` && n === `x64`) {
      return `https://bin.chatwise.app/bun-linux-x64.zip`;
    }
    if (t === `linux` && n === `arm64`) {
      return `https://bin.chatwise.app/bun-linux-aarch64.zip`;
    }
  }
  if (e === `node`) {
    if (t === `darwin` && n === `x64`) {
      return `https://bin.chatwise.app/node-darwin-x64.zip`;
    }
    if (t === `darwin` && n === `arm64`) {
      return `https://bin.chatwise.app/node-darwin-aarch64.zip`;
    }
    if ((t === `win32` && n === `x64`) || (t === `win32` && n === `arm64`)) {
      return `https://bin.chatwise.app/node-windows-x64.zip`;
    }
    if (t === `linux` && n === `x64`) {
      return `https://bin.chatwise.app/node-linux-x64.zip`;
    }
    if (t === `linux` && n === `arm64`) {
      return `https://bin.chatwise.app/node-linux-aarch64.zip`;
    }
  }
  throw Error(`Unsupported ${e} binary for ${t}/${n}`);
}
function ui(e) {
  if (process.platform === `win32`) {
    return `${e}.exe`;
  } else {
    return e;
  }
}
function di(e) {
  return F.existsSync(L.join(En, ui(e)));
}
async function fi(e, t) {
  let n = await F.promises.readdir(e, {
    withFileTypes: true,
  });
  for (let r of n) {
    let n = L.join(e, r.name);
    if (r.isFile() && r.name === t) {
      return n;
    }
    if (r.isDirectory()) {
      let e = await fi(n, t);
      if (e) {
        return e;
      }
    }
  }
  return null;
}
async function pi(e) {
  let t = await fetch(li(e));
  if (!t.ok) {
    throw Error(`Failed to download ${e}: HTTP ${t.status}`);
  }
  let n = L.join(
    P.tmpdir(),
    `${e}-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`,
  );
  let r = await j(L.join(P.tmpdir(), `${e}-extract-`));
  let i = ui(e);
  try {
    let e = await t.arrayBuffer();
    await N(n, Buffer.from(e));
    await A(En, {
      recursive: true,
    });
    await ni(n, r);
    let a = await fi(r, i);
    if (!a) {
      throw Error(`Downloaded archive does not contain ${i}`);
    }
    let o = L.join(En, i);
    await ee(a, o);
    if (process.platform !== `win32`) {
      await k(o, 493);
    }
  } finally {
    await Promise.allSettled([
      te(n, {
        force: true,
      }),
      te(r, {
        recursive: true,
        force: true,
      }),
    ]);
  }
}
async function mi(e, t) {
  try {
    let { stdout: n } = await Q(e, [`--version`], {
      throwOnError: true,
      nodeOptions: {
        env: t,
      },
    });
    return gi(n.trim(), e === `bun` ? `1.1.40` : `22.0.0`);
  } catch {
    return false;
  }
}
function hi(e) {
  let t = e.match(/(\d+)\.(\d+)\.(\d+)$/);
  if (t) {
    return {
      major: parseInt(t[1]),
      minor: parseInt(t[2]),
      patch: parseInt(t[3]),
    };
  } else {
    return null;
  }
}
function gi(e, t) {
  let n = hi(e);
  let r = hi(t);
  if (!n || !r) {
    return false;
  } else if (n.major === r.major) {
    if (n.minor === r.minor) {
      return n.patch > r.patch;
    } else {
      return n.minor > r.minor;
    }
  } else {
    return n.major > r.major;
  }
}
async function _i(e, t) {
  for (let [n, r] of Object.entries(t)) {
    let t = L.join(e, n);
    await A(L.dirname(t), {
      recursive: true,
    });
    await N(t, r.code, `utf8`);
  }
}
async function vi(e, t, n) {
  let r = L.join(P.tmpdir(), e);
  let i = [`i`, `--registry`, `https://npm.chatwise.app`];
  await A(r, {
    recursive: true,
  });
  await _i(r, t);
  let a = await Q(`bun`, i, {
    nodeOptions: {
      cwd: r,
      env: n,
    },
    throwOnError: false,
  });
  let o = a.stdout + a.stderr;
  if (a.exitCode !== 0) {
    throw Error(`failed to install dependencies: ${o}`);
  }
  return {
    cwd: r,
    logs: o,
  };
}
const yi = 59735;
let bi;
let xi;
function Si(e, t) {
  n.getAllWindows().forEach((n) => {
    Z(n.webContents).oauthCallback.send({
      eventName: e,
      data: t,
    });
  });
}
function Ci(e) {
  if (e.error) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Authorization Failed - ChatWise (${e.mcp_server_id})</title>
        <meta charset="utf-8">
        <style>
          body { font-family: system-ui, -apple-system, sans-serif; padding: 40px; text-align: center; }
          .error { color: #dc3545; }
          h1 { color: #333; }
          p { color: #666; }
        </style>
      </head>
      <body>
        <h1 class="error">Authorization Failed</h1>
        <p><strong>Error:</strong> ${e.error}</p>
        <p>${e.error_description ?? ``}</p>
        <p>You can close this window and return to ChatWise.</p>
      </body>
      </html>
    `;
  } else if (e.code) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Authorization Successful - ChatWise (${e.mcp_server_id})</title>
        <meta charset="utf-8">
        <style>
          body { font-family: system-ui, -apple-system, sans-serif; padding: 40px; text-align: center; }
          .success { color: #28a745; }
          h1 { color: #333; }
          p { color: #666; }
        </style>
      </head>
      <body>
        <h1 class="success">Authorization Successful!</h1>
        <p>MCP Server: <strong>${e.mcp_server_id}</strong></p>
        <p>You can close this window and return to ChatWise.</p>
        <script>
          setTimeout(() => window.close(), 3000);
        <\/script>
      </body>
      </html>
    `;
  } else {
    return `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Invalid Request - ChatWise (${e.mcp_server_id})</title>
      <meta charset="utf-8">
      <style>
        body { font-family: system-ui, -apple-system, sans-serif; padding: 40px; text-align: center; }
        .error { color: #dc3545; }
        h1 { color: #333; }
        p { color: #666; }
      </style>
    </head>
    <body>
      <h1 class="error">Invalid Request</h1>
      <p>No authorization code or error received for MCP Server: <strong>${e.mcp_server_id}</strong></p>
      <p>You can close this window and return to ChatWise.</p>
    </body>
    </html>
  `;
  }
}
function wi(e) {
  if (e.error) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Authorization Failed - ChatWise (Google AI)</title>
        <meta charset="utf-8">
        <style>
          body { font-family: system-ui, -apple-system, sans-serif; padding: 40px; text-align: center; }
          .error { color: #dc3545; }
          h1 { color: #333; }
          p { color: #666; }
        </style>
      </head>
      <body>
        <h1 class="error">Authorization Failed</h1>
        <p><strong>Error:</strong> ${e.error}</p>
        <p>${e.error_description ?? ``}</p>
        <p>You can close this window and return to ChatWise.</p>
      </body>
      </html>
    `;
  } else if (e.code) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Authorization Successful - ChatWise (Google AI)</title>
        <meta charset="utf-8">
        <style>
          body { font-family: system-ui, -apple-system, sans-serif; padding: 40px; text-align: center; }
          .success { color: #28a745; }
          h1 { color: #333; }
          p { color: #666; }
        </style>
      </head>
      <body>
        <h1 class="success">Authorization Successful!</h1>
        <p>You can close this window and return to ChatWise.</p>
        <script>
          setTimeout(() => window.close(), 3000);
        <\/script>
      </body>
      </html>
    `;
  } else {
    return `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Invalid Request - ChatWise (Google AI)</title>
      <meta charset="utf-8">
      <style>
        body { font-family: system-ui, -apple-system, sans-serif; padding: 40px; text-align: center; }
        .error { color: #dc3545; }
        h1 { color: #333; }
        p { color: #666; }
      </style>
    </head>
    <body>
      <h1 class="error">Invalid Request</h1>
      <p>No authorization code or error received.</p>
      <p>You can close this window and return to ChatWise.</p>
    </body>
    </html>
  `;
  }
}
function Ti(e, t) {
  e.writeHead(200, {
    "Content-Type": `text/html; charset=utf-8`,
  });
  e.end(t);
}
function Ei(e, t) {
  return {
    code: t.get(`code`) ?? undefined,
    error: t.get(`error`) ?? undefined,
    error_description: t.get(`error_description`) ?? undefined,
    mcp_server_id: e,
    state: t.get(`state`) ?? undefined,
  };
}
function Di(e, t) {
  let n = new URL(e.url ?? `/`, `http://127.0.0.1:${yi}`);
  let r = n.pathname;
  if (r === `/oauth2callback`) {
    let e = Ei(`googleai`, n.searchParams);
    Si(`oauth-callback-googleai`, e);
    Ti(t, wi(e));
    return;
  }
  if (r.startsWith(`/callback/`)) {
    let e = decodeURIComponent(r.slice(10));
    let i = Ei(e, n.searchParams);
    Si(`oauth-callback-mcp-${e}`, i);
    Ti(t, Ci(i));
    return;
  }
  t.writeHead(404, {
    "Content-Type": `text/plain; charset=utf-8`,
  });
  t.end(`Not Found`);
}
async function Oi() {
  if (!bi?.listening) {
    if (xi) {
      await xi;
      return;
    }
    xi = new Promise((e, t) => {
      let n = ae(Di);
      n.once(`error`, (e) => {
        bi = undefined;
        t(e);
      });
      n.listen(yi, `127.0.0.1`, () => {
        bi = n;
        e();
      });
    }).finally(() => {
      xi = undefined;
    });
    await xi;
  }
}
async function ki() {
  let e = bi;
  bi = undefined;
  if (e) {
    await new Promise((t, n) => {
      e.close((e) => {
        if (e) {
          n(e);
          return;
        }
        t();
      });
    });
  }
}
const Ai = new Map();
const ji = `persist:in-app-browser`;
const Mi = new Set([
  `stylesheet`,
  `image`,
  `media`,
  `font`,
  `object`,
  `ping`,
  `cspReport`,
  `webSocket`,
]);
const Ni = `manual`;
let Pi;
let Fi = false;
const Ii = [];
let Li;
function Ri() {
  let e = h.fromPartition(ji);
  if (!Fi) {
    Fi = true;
    e.webRequest.onBeforeRequest(
      {
        urls: [`*://*/*`],
      },
      (e, t) => {
        if (e.resourceType === `mainFrame`) {
          return t({
            cancel: false,
          });
        }
        for (let n of Ii) {
          if (n(e)) {
            return t({
              cancel: true,
            });
          }
        }
        t({
          cancel: false,
        });
      },
    );
  }
  return e;
}
async function zi() {
  Pi ||= fetch(`https://unpkg.com/defuddle@0.12.0/dist/index.js`).then(
    async (e) => {
      if (!e.ok) {
        throw Error(
          `Failed to fetch Defuddle script: ${e.status} ${e.statusText}`,
        );
      }
      return e.text();
    },
  );
  return Pi;
}
function Bi() {
  return `client://app/in-app-browser`;
}
async function Vi() {
  let e = Ri();
  let t = Pn();
  let n = t.proxy_url?.trim() || undefined;
  let r = t.proxy_bypass_rules || Mn;
  let i = n
    ? {
        mode: `fixed_servers`,
        proxyRules: n,
        proxyBypassRules: r,
      }
    : {
        mode: `system`,
      };
  let a = JSON.stringify(i);
  if (a !== Li) {
    await e.setProxy(i);
    Li = a;
  }
}
function Hi(e) {
  return {
    url: e.getURL(),
    title: e.getTitle(),
    canGoBack: e.navigationHistory.canGoBack(),
    canGoForward: e.navigationHistory.canGoForward(),
    isLoading: e.isLoading(),
  };
}
function Ui(e) {
  return e.toLowerCase();
}
function Wi(e, t) {
  let n = Ui(e);
  let r = Ui(t.trim());
  if (!r) {
    return false;
  }
  if (r.startsWith(`*.`)) {
    let e = r.slice(2);
    return n === e || n.endsWith(`.${e}`);
  }
  return n === r;
}
function Gi(e, t) {
  if (!t || t.length === 0) {
    return true;
  }
  try {
    let n = new URL(e);
    if (n.protocol !== `http:` && n.protocol !== `https:`) {
      return true;
    } else {
      return t.some((e) => Wi(n.hostname, e));
    }
  } catch {
    return true;
  }
}
function Ki(e) {
  let t = Ai.get(e);
  if (!t) {
    throw Error(`in-app browser session "${e}" was not found`);
  }
  return t;
}
function qi(e) {
  let t = [...Ai.values()].find((t) => t.window.id === e.id);
  if (!t) {
    throw Error(`in-app browser window was not found`);
  }
  return t;
}
async function Ji(e, t, n) {
  let r;
  try {
    return await Promise.race([
      e,
      new Promise((e, i) => {
        r = setTimeout(() => {
          i(Error(n));
        }, t);
      }),
    ]);
  } finally {
    if (r) {
      clearTimeout(r);
    }
  }
}
async function Yi(e, t) {
  await Ji(
    new Promise((n, r) => {
      let i = false;
      let a = () => {
        e.off(`did-finish-load`, c);
        e.off(`did-fail-load`, l);
        e.off(`did-stop-loading`, u);
      };
      let o = () => {
        a();
        n();
      };
      let s = (e) => {
        a();
        r(e);
      };
      let c = () => {
        o();
      };
      let l = (e, t, n, r, a) => {
        if (a) {
          if (t === -3) {
            i = true;
            return;
          }
          s(Error(`${n} (${t}) loading '${r}'`));
        }
      };
      let u = () => {
        if (!i) {
          return;
        }
        let t = e.getURL();
        if (!!t && t !== `about:blank`) {
          o();
        }
      };
      e.on(`did-finish-load`, c);
      e.on(`did-fail-load`, l);
      e.on(`did-stop-loading`, u);
      e.loadURL(t, {
        userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36`,
      }).catch((e) => {
        if (String(e).includes(`ERR_ABORTED`)) {
          i = true;
          return;
        }
        s(e instanceof Error ? e : Error(String(e)));
      });
    }),
    30000,
    `timed out loading ${t}`,
  );
}
function Xi(e) {
  let t = e.trim();
  if (!t) {
    throw Error(`missing in-app browser url`);
  }
  return t;
}
async function Zi(e, t) {
  await Vi();
  await Yi(e, Xi(t));
}
function Qi(e, t) {
  let { width: n, height: r } = e.getContentBounds();
  t.setBounds({
    x: 0,
    y: 56,
    width: n,
    height: Math.max(0, r - 56),
  });
}
function $i(e, t, n) {
  let i = process.env.CHATWISE_DEV_MENU;
  let a = [];
  if (n.editFlags.canCut) {
    a.push({
      role: `cut`,
    });
  }
  if (n.editFlags.canCopy) {
    a.push({
      role: `copy`,
    });
  }
  if (n.editFlags.canPaste) {
    a.push({
      role: `paste`,
    });
  }
  if (a.length > 0 && i) {
    a.push({
      type: `separator`,
    });
  }
  if (i) {
    a.push({
      label: `Inspect Element`,
      click: () => {
        t.webContents.inspectElement(n.x, n.y);
      },
    });
  }
  let o = t.getBounds();
  r.buildFromTemplate(a).popup({
    window: e,
    x: o.x + n.x,
    y: o.y + n.y,
  });
}
function ea(e) {
  if (!e.window.isDestroyed()) {
    Z(e.window.webContents).inAppBrowserStateChanged.send(
      Hi(e.view.webContents),
    );
  }
}
async function ta(e, t) {
  await e.executeJavaScript(
    `
      new Promise((resolve, reject) => {
        const selector = ${JSON.stringify(t)}
        if (document.querySelector(selector)) {
          resolve(true)
          return
        }

        const timeout = window.setTimeout(() => {
          observer.disconnect()
          reject(new Error("Timed out waiting for selector: " + selector))
        }, 15000)

        const observer = new MutationObserver(() => {
          if (document.querySelector(selector)) {
            window.clearTimeout(timeout)
            observer.disconnect()
            resolve(true)
          }
        })

        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
        })
      })
    `,
    true,
  );
}
function na({ id: e, show: t }) {
  Ri();
  let r = n.getFocusedWindow();
  let i = new n({
    width: 1280,
    height: 900,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: `#ffffff`,
    titleBarStyle: `hiddenInset`,
    trafficLightPosition: {
      x: 14,
      y: 18,
    },
    webPreferences: {
      preload: L.join(import.meta.dirname, `./preload.js`),
    },
  });
  let a = new s({
    webPreferences: {
      partition: ji,
    },
  });
  let o = {
    id: e,
    window: i,
    view: a,
  };
  Ai.set(e, o);
  if (t) {
    i.showInactive();
    if (r && !r.isDestroyed()) {
      r.moveTop();
      r.focus();
    }
  }
  i.loadURL(Bi());
  i.contentView.addChildView(a);
  Qi(i, a);
  let c = () => {
    ea(o);
  };
  a.webContents.setWindowOpenHandler(({ url: e }) => {
    if (e.startsWith(`http://`) || e.startsWith(`https://`)) {
      Zi(a.webContents, e)
        .then(c)
        .catch((e) => {
          console.error(`failed to open in-app browser popup url`, e);
        });
    }
    return {
      action: `deny`,
    };
  });
  a.webContents.on(`did-start-loading`, c);
  a.webContents.on(`did-stop-loading`, c);
  a.webContents.on(`page-title-updated`, c);
  a.webContents.on(`did-navigate`, c);
  a.webContents.on(`did-navigate-in-page`, c);
  a.webContents.on(`context-menu`, (e, t) => {
    $i(i, a, t);
  });
  i.on(`resize`, () => {
    Qi(i, a);
  });
  i.on(`closed`, () => {
    ra(o);
  });
  return o;
}
function ra(e) {
  Ai.delete(e.id);
  if (!e.window.isDestroyed()) {
    e.window.contentView.removeChildView(e.view);
  }
  if (!e.view.webContents.isDestroyed()) {
    e.view.webContents.close();
  }
  if (!e.window.isDestroyed()) {
    e.window.destroy();
  }
}
async function ia(e) {
  let t = Ai.get(e);
  if (t) {
    ra(t);
  }
}
function aa(e, t) {
  Ii.push(e);
  return {
    [Symbol.dispose]() {
      console.log(`remove interceptor`);
      Ii.splice(Ii.indexOf(e), 1);
    },
    run: t,
  };
}
async function oa({ id: e, url: t, options: n }) {
  let r = Ki(e).view.webContents;
  let i = r.id;
  using a = aa(
    (e) => {
      if (
        e.webContentsId === i &&
        (Mi.has(e.resourceType) || !Gi(e.url, n.allowDomains))
      ) {
        return true;
      }
    },
    async () => {
      await Zi(r, t);
      if (n.waitForSelector) {
        await ta(r, n.waitForSelector);
      }
      if (n.defuddle) {
        let e = [
          `(() => {`,
          `if (typeof globalThis.Defuddle !== "function") {`,
          await zi(),
          `}`,
          `if (typeof globalThis.Defuddle !== "function") {`,
          `throw new Error("Defuddle failed to initialize")`,
          `}`,
          `const result = new globalThis.Defuddle(document, {`,
          `  url: location.href,`,
          `}).parse()`,
          `return result?.content || ""`,
          `})()`,
        ].join(`
`);
        return await r.executeJavaScript(e, true);
      }
      return await r.executeJavaScript(
        `document.documentElement?.outerHTML ?? ''`,
        true,
      );
    },
  );
  return await a.run();
}
async function sa(e) {
  await ia(e.id);
  na(e);
}
async function ca(e = `https://www.google.com`) {
  let t =
    Ai.get(Ni) ??
    na({
      id: Ni,
      show: false,
    });
  t.window.show();
  t.window.focus();
  await Zi(t.view.webContents, e);
  ea(t);
}
function la(e) {
  return Hi(qi(e).view.webContents);
}
async function ua(e, t) {
  let n = qi(e);
  await Zi(n.view.webContents, t);
  ea(n);
}
function da(e) {
  let t = qi(e);
  if (t.view.webContents.navigationHistory.canGoBack()) {
    t.view.webContents.navigationHistory.goBack();
  }
  ea(t);
}
function fa(e) {
  let t = qi(e);
  if (t.view.webContents.navigationHistory.canGoForward()) {
    t.view.webContents.navigationHistory.goForward();
  }
  ea(t);
}
function pa(e) {
  let t = qi(e);
  t.view.webContents.reload();
  ea(t);
}
async function ma(e) {
  await e.webContents.executeJavaScript(
    `
      Promise.all([
        document.fonts?.ready ?? Promise.resolve(),
        Promise.all(
          Array.from(document.images)
            .filter((image) => !image.complete)
            .map(
              (image) =>
                new Promise((resolve) => {
                  image.addEventListener("load", resolve, { once: true })
                  image.addEventListener("error", resolve, { once: true })
                }),
            ),
        ),
      ])
    `,
    true,
  );
}
async function ha(e, t) {
  let r = await j(L.join(P.tmpdir(), `chatwise-export-`));
  let i = L.join(r, `index.html`);
  let a = new n({
    show: false,
    autoHideMenuBar: true,
    width: 1280,
    height: 900,
  });
  try {
    await N(i, e, `utf8`);
    await a.loadFile(i);
    await ma(a);
    await N(
      t,
      await a.webContents.printToPDF({
        printBackground: true,
        preferCSSPageSize: true,
      }),
    );
  } finally {
    if (!a.isDestroyed()) {
      a.destroy();
    }
    await F.promises.rm(r, {
      recursive: true,
      force: true,
    });
  }
}
var ga = X((e) => {
  Object.defineProperty(e, `__esModule`, {
    value: true,
  });
  e.range = e.balanced = undefined;
  e.balanced = (n, r, i) => {
    let a = n instanceof RegExp ? t(n, i) : n;
    let o = r instanceof RegExp ? t(r, i) : r;
    let s = a !== null && o != null && (0, e.range)(a, o, i);
    return (
      s && {
        start: s[0],
        end: s[1],
        pre: i.slice(0, s[0]),
        body: i.slice(s[0] + a.length, s[1]),
        post: i.slice(s[1] + o.length),
      }
    );
  };
  let t = (e, t) => {
    let n = t.match(e);
    if (n) {
      return n[0];
    } else {
      return null;
    }
  };
  e.range = (e, t, n) => {
    let r;
    let i;
    let a;
    let o;
    let s;
    let c = n.indexOf(e);
    let l = n.indexOf(t, c + 1);
    let u = c;
    if (c >= 0 && l > 0) {
      if (e === t) {
        return [c, l];
      }
      r = [];
      a = n.length;
      while (u >= 0 && !s) {
        if (u === c) {
          r.push(u);
          c = n.indexOf(e, u + 1);
        } else if (r.length === 1) {
          let e = r.pop();
          if (e !== undefined) {
            s = [e, l];
          }
        } else {
          i = r.pop();
          if (i !== undefined && i < a) {
            a = i;
            o = l;
          }
          l = n.indexOf(t, u + 1);
        }
        u = c < l && c >= 0 ? c : l;
      }
      if (r.length && o !== undefined) {
        s = [a, o];
      }
    }
    return s;
  };
});
var _a = X((e) => {
  Object.defineProperty(e, `__esModule`, {
    value: true,
  });
  e.EXPANSION_MAX = undefined;
  e.expand = x;
  let t = ga();
  let n = `\0SLASH${Math.random()}\0`;
  let r = `\0OPEN${Math.random()}\0`;
  let i = `\0CLOSE${Math.random()}\0`;
  let a = `\0COMMA${Math.random()}\0`;
  let o = `\0PERIOD${Math.random()}\0`;
  let s = new RegExp(n, `g`);
  let c = new RegExp(r, `g`);
  let l = new RegExp(i, `g`);
  let u = new RegExp(a, `g`);
  let d = new RegExp(o, `g`);
  let f = /\\\\/g;
  let p = /\\{/g;
  let m = /\\}/g;
  let h = /\\,/g;
  let g = /\\\./g;
  e.EXPANSION_MAX = 100000;
  function _(e) {
    if (isNaN(e)) {
      return e.charCodeAt(0);
    } else {
      return parseInt(e, 10);
    }
  }
  function v(e) {
    return e
      .replace(f, n)
      .replace(p, r)
      .replace(m, i)
      .replace(h, a)
      .replace(g, o);
  }
  function y(e) {
    return e
      .replace(s, `\\`)
      .replace(c, `{`)
      .replace(l, `}`)
      .replace(u, `,`)
      .replace(d, `.`);
  }
  function b(e) {
    if (!e) {
      return [``];
    }
    let n = [];
    let r = (0, t.balanced)(`{`, `}`, e);
    if (!r) {
      return e.split(`,`);
    }
    let { pre: i, body: a, post: o } = r;
    let s = i.split(`,`);
    s[s.length - 1] += `{${a}}`;
    let c = b(o);
    if (o.length) {
      s[s.length - 1] += c.shift();
      s.push.apply(s, c);
    }
    n.push.apply(n, s);
    return n;
  }
  function x(t, n = {}) {
    if (!t) {
      return [];
    }
    let { max: r = e.EXPANSION_MAX } = n;
    if (t.slice(0, 2) === `{}`) {
      t = `\\{\\}${t.slice(2)}`;
    }
    return E(v(t), r, true).map(y);
  }
  function S(e) {
    return `{${e}}`;
  }
  function C(e) {
    return /^-?0\d/.test(e);
  }
  function w(e, t) {
    return e <= t;
  }
  function T(e, t) {
    return e >= t;
  }
  function E(e, n, r) {
    let a = [];
    let o = (0, t.balanced)(`{`, `}`, e);
    if (!o) {
      return [e];
    }
    let s = o.pre;
    let c = o.post.length ? E(o.post, n, false) : [``];
    if (/\$$/.test(o.pre)) {
      for (let e = 0; e < c.length && e < n; e++) {
        let t = `${s}{${o.body}}${c[e]}`;
        a.push(t);
      }
    } else {
      let t = /^-?\d+\.\.-?\d+(?:\.\.-?\d+)?$/.test(o.body);
      let l = /^[a-zA-Z]\.\.[a-zA-Z](?:\.\.-?\d+)?$/.test(o.body);
      let u = t || l;
      let d = o.body.indexOf(`,`) >= 0;
      if (!u && !d) {
        if (o.post.match(/,(?!,).*\}/)) {
          e = `${o.pre}{${o.body}${i}${o.post}`;
          return E(e, n, true);
        } else {
          return [e];
        }
      }
      let f;
      if (u) {
        f = o.body.split(/\.\./);
      } else {
        f = b(o.body);
        if (
          f.length === 1 &&
          f[0] !== undefined &&
          ((f = E(f[0], n, false).map(S)), f.length === 1)
        ) {
          return c.map((e) => o.pre + f[0] + e);
        }
      }
      let p;
      if (u && f[0] !== undefined && f[1] !== undefined) {
        let e = _(f[0]);
        let t = _(f[1]);
        let n = Math.max(f[0].length, f[1].length);
        let r = f.length === 3 && f[2] !== undefined ? Math.abs(_(f[2])) : 1;
        let i = w;
        if (t < e) {
          r *= -1;
          i = T;
        }
        let a = f.some(C);
        p = [];
        for (let o = e; i(o, t); o += r) {
          let e;
          if (l) {
            e = String.fromCharCode(o);
            if (e === `\\`) {
              e = ``;
            }
          } else {
            e = String(o);
            if (a) {
              let t = n - e.length;
              if (t > 0) {
                let n = Array(t + 1).join(`0`);
                e = o < 0 ? `-${n}${e.slice(1)}` : n + e;
              }
            }
          }
          p.push(e);
        }
      } else {
        p = [];
        for (let e = 0; e < f.length; e++) {
          p.push.apply(p, E(f[e], n, false));
        }
      }
      for (let e = 0; e < p.length; e++) {
        for (let t = 0; t < c.length && a.length < n; t++) {
          let n = s + p[e] + c[t];
          if (!r || u || n) {
            a.push(n);
          }
        }
      }
    }
    return a;
  }
});
var va = X((e) => {
  Object.defineProperty(e, `__esModule`, {
    value: true,
  });
  e.assertValidPattern = undefined;
  e.assertValidPattern = (e) => {
    if (typeof e != `string`) {
      throw TypeError(`invalid pattern`);
    }
    if (e.length > 65536) {
      throw TypeError(`pattern is too long`);
    }
  };
});
var ya = X((e) => {
  Object.defineProperty(e, `__esModule`, {
    value: true,
  });
  e.parseClass = undefined;
  let t = {
    "[:alnum:]": [`\\p{L}\\p{Nl}\\p{Nd}`, true],
    "[:alpha:]": [`\\p{L}\\p{Nl}`, true],
    "[:ascii:]": [`\\x00-\\x7f`, false],
    "[:blank:]": [`\\p{Zs}\\t`, true],
    "[:cntrl:]": [`\\p{Cc}`, true],
    "[:digit:]": [`\\p{Nd}`, true],
    "[:graph:]": [`\\p{Z}\\p{C}`, true, true],
    "[:lower:]": [`\\p{Ll}`, true],
    "[:print:]": [`\\p{C}`, true],
    "[:punct:]": [`\\p{P}`, true],
    "[:space:]": [`\\p{Z}\\t\\r\\n\\v\\f`, true],
    "[:upper:]": [`\\p{Lu}`, true],
    "[:word:]": [`\\p{L}\\p{Nl}\\p{Nd}\\p{Pc}`, true],
    "[:xdigit:]": [`A-Fa-f0-9`, false],
  };
  let n = (e) => e.replace(/[[\]\\-]/g, `\\$&`);
  let r = (e) => e.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, `\\$&`);
  let i = (e) => e.join(``);
  e.parseClass = (e, a) => {
    let o = a;
    if (e.charAt(o) !== `[`) {
      throw Error(`not in a brace expression`);
    }
    let s = [];
    let c = [];
    let l = o + 1;
    let u = false;
    let d = false;
    let f = false;
    let p = false;
    let m = o;
    let h = ``;
    WHILE: while (l < e.length) {
      let r = e.charAt(l);
      if ((r === `!` || r === `^`) && l === o + 1) {
        p = true;
        l++;
        continue;
      }
      if (r === `]` && u && !f) {
        m = l + 1;
        break;
      }
      u = true;
      if (r === `\\` && !f) {
        f = true;
        l++;
        continue;
      }
      if (r === `[` && !f) {
        for (let [n, [r, i, a]] of Object.entries(t)) {
          if (e.startsWith(n, l)) {
            if (h) {
              return [`$.`, false, e.length - o, true];
            }
            l += n.length;
            if (a) {
              c.push(r);
            } else {
              s.push(r);
            }
            d ||= i;
            continue WHILE;
          }
        }
      }
      f = false;
      if (h) {
        if (r > h) {
          s.push(`${n(h)}-${n(r)}`);
        } else if (r === h) {
          s.push(n(r));
        }
        h = ``;
        l++;
        continue;
      }
      if (e.startsWith(`-]`, l + 1)) {
        s.push(n(`${r}-`));
        l += 2;
        continue;
      }
      if (e.startsWith(`-`, l + 1)) {
        h = r;
        l += 2;
        continue;
      }
      s.push(n(r));
      l++;
    }
    if (m < l) {
      return [``, false, 0, false];
    }
    if (!s.length && !c.length) {
      return [`$.`, false, e.length - o, true];
    }
    if (c.length === 0 && s.length === 1 && /^\\?.$/.test(s[0]) && !p) {
      return [
        r(s[0].length === 2 ? s[0].slice(-1) : s[0]),
        false,
        m - o,
        false,
      ];
    }
    let g = `[${p ? `^` : ``}${i(s)}]`;
    let _ = `[${p ? `` : `^`}${i(c)}]`;
    return [
      s.length && c.length ? `(${g}|${_})` : s.length ? g : _,
      d,
      m - o,
      true,
    ];
  };
});
var ba = X((e) => {
  Object.defineProperty(e, `__esModule`, {
    value: true,
  });
  e.unescape = undefined;
  e.unescape = (
    e,
    { windowsPathsNoEscape: t = false, magicalBraces: n = true } = {},
  ) =>
    n
      ? t
        ? e.replace(/\[([^\/\\])\]/g, `$1`)
        : e
            .replace(/((?!\\).|^)\[([^\/\\])\]/g, `$1$2`)
            .replace(/\\([^\/])/g, `$1`)
      : t
        ? e.replace(/\[([^\/\\{}])\]/g, `$1`)
        : e
            .replace(/((?!\\).|^)\[([^\/\\{}])\]/g, `$1$2`)
            .replace(/\\([^\/{}])/g, `$1`);
});
var xa = X((e) => {
  var t;
  Object.defineProperty(e, `__esModule`, {
    value: true,
  });
  e.AST = undefined;
  let n = ya();
  let r = ba();
  let i = new Set([`!`, `?`, `+`, `*`, `@`]);
  let a = (e) => i.has(e);
  let o = (e) => a(e.type);
  let s = new Map([
    [`!`, [`@`]],
    [`?`, [`?`, `@`]],
    [`@`, [`@`]],
    [`*`, [`*`, `+`, `?`, `@`]],
    [`+`, [`+`, `@`]],
  ]);
  let c = new Map([
    [`!`, [`?`]],
    [`@`, [`?`]],
    [`+`, [`?`, `*`]],
  ]);
  let l = new Map([
    [`!`, [`?`, `@`]],
    [`?`, [`?`, `@`]],
    [`@`, [`?`, `@`]],
    [`*`, [`*`, `+`, `?`, `@`]],
    [`+`, [`+`, `@`, `?`, `*`]],
  ]);
  let u = new Map([
    [`!`, new Map([[`!`, `@`]])],
    [
      `?`,
      new Map([
        [`*`, `*`],
        [`+`, `*`],
      ]),
    ],
    [
      `@`,
      new Map([
        [`!`, `!`],
        [`?`, `?`],
        [`@`, `@`],
        [`*`, `*`],
        [`+`, `+`],
      ]),
    ],
    [
      `+`,
      new Map([
        [`?`, `*`],
        [`*`, `*`],
      ]),
    ],
  ]);
  let d = `(?!\\.)`;
  let f = new Set([`[`, `.`]);
  let p = new Set([`..`, `.`]);
  let m = new Set(`().*{}+?[]^$\\!`);
  let h = (e) => e.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, `\\$&`);
  let g = `[^/]`;
  let _ = `${g}*?`;
  let v = `${g}+?`;
  let y = 0;
  var b = class {
    type;
    #e;
    #t;
    #n = false;
    #r = [];
    #i;
    #a;
    #o;
    #s = false;
    #c;
    #l;
    #u = false;
    id = ++y;
    get depth() {
      return (this.#i?.depth ?? -1) + 1;
    }
    [Symbol.for(`nodejs.util.inspect.custom`)]() {
      return {
        "@@type": `AST`,
        id: this.id,
        type: this.type,
        root: this.#e.id,
        parent: this.#i?.id,
        depth: this.depth,
        partsLength: this.#r.length,
        parts: this.#r,
      };
    }
    constructor(e, t, n = {}) {
      this.type = e;
      if (e) {
        this.#t = true;
      }
      this.#i = t;
      this.#e = this.#i ? this.#i.#e : this;
      this.#c = this.#e === this ? n : this.#e.#c;
      this.#o = this.#e === this ? [] : this.#e.#o;
      if (e === `!` && !this.#e.#s) {
        this.#o.push(this);
      }
      this.#a = this.#i ? this.#i.#r.length : 0;
    }
    get hasMagic() {
      if (this.#t !== undefined) {
        return this.#t;
      }
      for (let e of this.#r) {
        if (typeof e != `string` && (e.type || e.hasMagic)) {
          return (this.#t = true);
        }
      }
      return this.#t;
    }
    toString() {
      if (this.#l === undefined) {
        if (this.type) {
          return (this.#l = `${this.type}(${this.#r.map((e) => String(e)).join(`|`)})`);
        } else {
          return (this.#l = this.#r.map((e) => String(e)).join(``));
        }
      } else {
        return this.#l;
      }
    }
    #d() {
      if (this !== this.#e) {
        throw Error(`should only call on root`);
      }
      if (this.#s) {
        return this;
      }
      this.toString();
      this.#s = true;
      let e;
      while ((e = this.#o.pop())) {
        if (e.type !== `!`) {
          continue;
        }
        let t = e;
        let n = t.#i;
        while (n) {
          for (let r = t.#a + 1; !n.type && r < n.#r.length; r++) {
            for (let t of e.#r) {
              if (typeof t == `string`) {
                throw Error(`string part in extglob AST??`);
              }
              t.copyIn(n.#r[r]);
            }
          }
          t = n;
          n = t.#i;
        }
      }
      return this;
    }
    push(...e) {
      for (let n of e) {
        if (n !== ``) {
          if (typeof n != `string` && (!(n instanceof t) || n.#i !== this)) {
            throw Error(`invalid part: ${n}`);
          }
          this.#r.push(n);
        }
      }
    }
    toJSON() {
      let e =
        this.type === null
          ? this.#r.slice().map((e) => (typeof e == `string` ? e : e.toJSON()))
          : [this.type, ...this.#r.map((e) => e.toJSON())];
      if (this.isStart() && !this.type) {
        e.unshift([]);
      }
      if (
        this.isEnd() &&
        (this === this.#e || (this.#e.#s && this.#i?.type === `!`))
      ) {
        e.push({});
      }
      return e;
    }
    isStart() {
      if (this.#e === this) {
        return true;
      }
      if (!this.#i?.isStart()) {
        return false;
      }
      if (this.#a === 0) {
        return true;
      }
      let e = this.#i;
      for (let n = 0; n < this.#a; n++) {
        let r = e.#r[n];
        if (!(r instanceof t) || r.type !== `!`) {
          return false;
        }
      }
      return true;
    }
    isEnd() {
      if (this.#e === this || this.#i?.type === `!`) {
        return true;
      }
      if (!this.#i?.isEnd()) {
        return false;
      }
      if (!this.type) {
        return this.#i?.isEnd();
      }
      let e = this.#i ? this.#i.#r.length : 0;
      return this.#a === e - 1;
    }
    copyIn(e) {
      if (typeof e == `string`) {
        this.push(e);
      } else {
        this.push(e.clone(this));
      }
    }
    clone(e) {
      let n = new t(this.type, e);
      for (let e of this.#r) {
        n.copyIn(e);
      }
      return n;
    }
    static #f(e, n, r, i, o) {
      let s = i.maxExtglobRecursion ?? 2;
      let c = false;
      let l = false;
      let u = -1;
      let d = false;
      if (n.type === null) {
        let f = r;
        let p = ``;
        while (f < e.length) {
          let r = e.charAt(f++);
          if (c || r === `\\`) {
            c = !c;
            p += r;
            continue;
          }
          if (l) {
            if (f === u + 1) {
              if (r === `^` || r === `!`) {
                d = true;
              }
            } else if (r === `]` && (f !== u + 2 || !d)) {
              l = false;
            }
            p += r;
            continue;
          } else if (r === `[`) {
            l = true;
            u = f;
            d = false;
            p += r;
            continue;
          }
          if (!i.noext && a(r) && e.charAt(f) === `(` && o <= s) {
            n.push(p);
            p = ``;
            let a = new t(r, n);
            f = t.#f(e, a, f, i, o + 1);
            n.push(a);
            continue;
          }
          p += r;
        }
        n.push(p);
        return f;
      }
      let f = r + 1;
      let p = new t(null, n);
      let m = [];
      let h = ``;
      while (f < e.length) {
        let r = e.charAt(f++);
        if (c || r === `\\`) {
          c = !c;
          h += r;
          continue;
        }
        if (l) {
          if (f === u + 1) {
            if (r === `^` || r === `!`) {
              d = true;
            }
          } else if (r === `]` && (f !== u + 2 || !d)) {
            l = false;
          }
          h += r;
          continue;
        } else if (r === `[`) {
          l = true;
          u = f;
          d = false;
          h += r;
          continue;
        }
        if (
          !i.noext &&
          a(r) &&
          e.charAt(f) === `(` &&
          (o <= s || (n && n.#h(r)))
        ) {
          let a = n && n.#h(r) ? 0 : 1;
          p.push(h);
          h = ``;
          let s = new t(r, p);
          p.push(s);
          f = t.#f(e, s, f, i, o + a);
          continue;
        }
        if (r === `|`) {
          p.push(h);
          h = ``;
          m.push(p);
          p = new t(null, n);
          continue;
        }
        if (r === `)`) {
          if (h === `` && n.#r.length === 0) {
            n.#u = true;
          }
          p.push(h);
          h = ``;
          n.push(...m, p);
          return f;
        }
        h += r;
      }
      n.type = null;
      n.#t = undefined;
      n.#r = [e.substring(r - 1)];
      return f;
    }
    #p(e) {
      return this.#m(e, c);
    }
    #m(e, t = s) {
      if (
        !e ||
        typeof e != `object` ||
        e.type !== null ||
        e.#r.length !== 1 ||
        this.type === null
      ) {
        return false;
      }
      let n = e.#r[0];
      if (!n || typeof n != `object` || n.type === null) {
        return false;
      } else {
        return this.#h(n.type, t);
      }
    }
    #h(e, t = l) {
      return !!t.get(this.type)?.includes(e);
    }
    #g(e, n) {
      let r = e.#r[0];
      let i = new t(null, r, this.options);
      i.#r.push(``);
      r.push(i);
      this.#_(e, n);
    }
    #_(e, t) {
      let n = e.#r[0];
      this.#r.splice(t, 1, ...n.#r);
      for (let e of n.#r) {
        if (typeof e == `object`) {
          e.#i = this;
        }
      }
      this.#l = undefined;
    }
    #v(e) {
      return !!u.get(this.type)?.has(e);
    }
    #y(e) {
      if (
        !e ||
        typeof e != `object` ||
        e.type !== null ||
        e.#r.length !== 1 ||
        this.type === null ||
        this.#r.length !== 1
      ) {
        return false;
      }
      let t = e.#r[0];
      if (!t || typeof t != `object` || t.type === null) {
        return false;
      } else {
        return this.#v(t.type);
      }
    }
    #b(e) {
      let t = u.get(this.type);
      let n = e.#r[0];
      let r = t?.get(n.type);
      if (!r) {
        return false;
      }
      this.#r = n.#r;
      for (let e of this.#r) {
        if (typeof e == `object`) {
          e.#i = this;
        }
      }
      this.type = r;
      this.#l = undefined;
      this.#u = false;
    }
    static fromGlob(e, n = {}) {
      let r = new t(null, undefined, n);
      t.#f(e, r, 0, n, 0);
      return r;
    }
    toMMPattern() {
      if (this !== this.#e) {
        return this.#e.toMMPattern();
      }
      let e = this.toString();
      let [t, n, r, i] = this.toRegExpSource();
      if (
        !r &&
        !this.#t &&
        (!this.#c.nocase ||
          !!this.#c.nocaseMagicOnly ||
          e.toUpperCase() === e.toLowerCase())
      ) {
        return n;
      }
      let a = (this.#c.nocase ? `i` : ``) + (i ? `u` : ``);
      return Object.assign(RegExp(`^${t}$`, a), {
        _src: t,
        _glob: e,
      });
    }
    get options() {
      return this.#c;
    }
    toRegExpSource(e) {
      let n = e ?? !!this.#c.dot;
      if (this.#e === this) {
        this.#x();
        this.#d();
      }
      if (!o(this)) {
        let i =
          this.isStart() &&
          this.isEnd() &&
          !this.#r.some((e) => typeof e != `string`);
        let a = this.#r
          .map((n) => {
            let [r, a, o, s] =
              typeof n == `string` ? t.#C(n, this.#t, i) : n.toRegExpSource(e);
            this.#t = this.#t || o;
            this.#n = this.#n || s;
            return r;
          })
          .join(``);
        let o = ``;
        if (
          this.isStart() &&
          typeof this.#r[0] == `string` &&
          (this.#r.length !== 1 || !p.has(this.#r[0]))
        ) {
          let t = f;
          let r =
            (n && t.has(a.charAt(0))) ||
            (a.startsWith(`\\.`) && t.has(a.charAt(2))) ||
            (a.startsWith(`\\.\\.`) && t.has(a.charAt(4)));
          let i = !n && !e && t.has(a.charAt(0));
          o = r ? `(?!(?:^|/)\\.\\.?(?:$|/))` : i ? d : ``;
        }
        let s = ``;
        if (this.isEnd() && this.#e.#s && this.#i?.type === `!`) {
          s = `(?:$|\\/)`;
        }
        return [o + a + s, (0, r.unescape)(a), (this.#t = !!this.#t), this.#n];
      }
      let i = this.type === `*` || this.type === `+`;
      let a = this.type === `!` ? `(?:(?!(?:` : `(?:`;
      let s = this.#S(n);
      if (this.isStart() && this.isEnd() && !s && this.type !== `!`) {
        let e = this.toString();
        let t = this;
        t.#r = [e];
        t.type = null;
        t.#t = undefined;
        return [e, (0, r.unescape)(this.toString()), false, false];
      }
      let c = !i || e || n ? `` : this.#S(true);
      if (c === s) {
        c = ``;
      }
      if (c) {
        s = `(?:${s})(?:${c})*?`;
      }
      let l = ``;
      if (this.type === `!` && this.#u) {
        l = (this.isStart() && !n ? d : ``) + v;
      } else {
        let t =
          this.type === `!`
            ? `))${this.isStart() && !n && !e ? d : ``}${_})`
            : this.type === `@`
              ? `)`
              : this.type === `?`
                ? `)?`
                : this.type === `+` && c
                  ? `)`
                  : this.type === `*` && c
                    ? `)?`
                    : `)${this.type}`;
        l = a + s + t;
      }
      return [l, (0, r.unescape)(s), (this.#t = !!this.#t), this.#n];
    }
    #x() {
      if (o(this)) {
        let e = 0;
        let t = false;
        do {
          t = true;
          for (let e = 0; e < this.#r.length; e++) {
            let n = this.#r[e];
            if (typeof n == `object`) {
              n.#x();
              if (this.#m(n)) {
                t = false;
                this.#_(n, e);
              } else if (this.#p(n)) {
                t = false;
                this.#g(n, e);
              } else if (this.#y(n)) {
                t = false;
                this.#b(n);
              }
            }
          }
        } while (!t && ++e < 10);
      } else {
        for (let e of this.#r) {
          if (typeof e == `object`) {
            e.#x();
          }
        }
      }
      this.#l = undefined;
    }
    #S(e) {
      return this.#r
        .map((t) => {
          if (typeof t == `string`) {
            throw Error(`string type in extglob ast??`);
          }
          let [n, r, i, a] = t.toRegExpSource(e);
          this.#n = this.#n || a;
          return n;
        })
        .filter((e) => !this.isStart() || !this.isEnd() || !!e)
        .join(`|`);
    }
    static #C(e, t, i = false) {
      let a = false;
      let o = ``;
      let s = false;
      let c = false;
      for (let r = 0; r < e.length; r++) {
        let l = e.charAt(r);
        if (a) {
          a = false;
          o += (m.has(l) ? `\\` : ``) + l;
          continue;
        }
        if (l === `*`) {
          if (c) {
            continue;
          }
          c = true;
          o += i && /^[*]+$/.test(e) ? v : _;
          t = true;
          continue;
        } else {
          c = false;
        }
        if (l === `\\`) {
          if (r === e.length - 1) {
            o += `\\\\`;
          } else {
            a = true;
          }
          continue;
        }
        if (l === `[`) {
          let [i, a, c, l] = (0, n.parseClass)(e, r);
          if (c) {
            o += i;
            s ||= a;
            r += c - 1;
            t ||= l;
            continue;
          }
        }
        if (l === `?`) {
          o += g;
          t = true;
          continue;
        }
        o += h(l);
      }
      return [o, (0, r.unescape)(e), !!t, s];
    }
  };
  e.AST = b;
  t = b;
});
var Sa = X((e) => {
  Object.defineProperty(e, `__esModule`, {
    value: true,
  });
  e.escape = undefined;
  e.escape = (
    e,
    { windowsPathsNoEscape: t = false, magicalBraces: n = false } = {},
  ) =>
    n
      ? t
        ? e.replace(/[?*()[\]{}]/g, `[$&]`)
        : e.replace(/[?*()[\]\\{}]/g, `\\$&`)
      : t
        ? e.replace(/[?*()[\]]/g, `[$&]`)
        : e.replace(/[?*()[\]\\]/g, `\\$&`);
});
var Ca = X((e) => {
  Object.defineProperty(e, `__esModule`, {
    value: true,
  });
  e.unescape =
    e.escape =
    e.AST =
    e.Minimatch =
    e.match =
    e.makeRe =
    e.braceExpand =
    e.defaults =
    e.filter =
    e.GLOBSTAR =
    e.sep =
    e.minimatch =
      undefined;
  let t = _a();
  let n = va();
  let r = xa();
  let i = Sa();
  let a = ba();
  e.minimatch = (e, t, r = {}) => {
    (0, n.assertValidPattern)(t);
    if (!r.nocomment && t.charAt(0) === `#`) {
      return false;
    } else {
      return new A(t, r).match(e);
    }
  };
  let o = /^\*+([^+@!?\*\[\(]*)$/;
  let s = (e) => (t) => !t.startsWith(`.`) && t.endsWith(e);
  let c = (e) => (t) => t.endsWith(e);
  let l = (e) => {
    e = e.toLowerCase();
    return (t) => !t.startsWith(`.`) && t.toLowerCase().endsWith(e);
  };
  let u = (e) => {
    e = e.toLowerCase();
    return (t) => t.toLowerCase().endsWith(e);
  };
  let d = /^\*+\.\*+$/;
  let f = (e) => !e.startsWith(`.`) && e.includes(`.`);
  let p = (e) => e !== `.` && e !== `..` && e.includes(`.`);
  let m = /^\.\*+$/;
  let h = (e) => e !== `.` && e !== `..` && e.startsWith(`.`);
  let g = /^\*+$/;
  let _ = (e) => e.length !== 0 && !e.startsWith(`.`);
  let v = (e) => e.length !== 0 && e !== `.` && e !== `..`;
  let y = /^\?+([^+@!?\*\[\(]*)?$/;
  let b = ([e, t = ``]) => {
    let n = w([e]);
    if (t) {
      t = t.toLowerCase();
      return (e) => n(e) && e.toLowerCase().endsWith(t);
    } else {
      return n;
    }
  };
  let x = ([e, t = ``]) => {
    let n = T([e]);
    if (t) {
      t = t.toLowerCase();
      return (e) => n(e) && e.toLowerCase().endsWith(t);
    } else {
      return n;
    }
  };
  let S = ([e, t = ``]) => {
    let n = T([e]);
    if (t) {
      return (e) => n(e) && e.endsWith(t);
    } else {
      return n;
    }
  };
  let C = ([e, t = ``]) => {
    let n = w([e]);
    if (t) {
      return (e) => n(e) && e.endsWith(t);
    } else {
      return n;
    }
  };
  let w = ([e]) => {
    let t = e.length;
    return (e) => e.length === t && !e.startsWith(`.`);
  };
  let T = ([e]) => {
    let t = e.length;
    return (e) => e.length === t && e !== `.` && e !== `..`;
  };
  let E =
    typeof process == `object` && process
      ? (typeof process.env == `object` &&
          process.env &&
          process.env.__MINIMATCH_TESTING_PLATFORM__) ||
        process.platform
      : `posix`;
  let D = {
    win32: {
      sep: `\\`,
    },
    posix: {
      sep: `/`,
    },
  };
  e.sep = E === `win32` ? D.win32.sep : D.posix.sep;
  e.minimatch.sep = e.sep;
  e.GLOBSTAR = Symbol(`globstar **`);
  e.minimatch.GLOBSTAR = e.GLOBSTAR;
  e.filter =
    (t, n = {}) =>
    (r) =>
      (0, e.minimatch)(r, t, n);
  e.minimatch.filter = e.filter;
  let O = (e, t = {}) => Object.assign({}, e, t);
  e.defaults = (t) => {
    if (!t || typeof t != `object` || !Object.keys(t).length) {
      return e.minimatch;
    }
    let n = e.minimatch;
    return Object.assign((e, r, i = {}) => n(e, r, O(t, i)), {
      Minimatch: class extends n.Minimatch {
        constructor(e, n = {}) {
          super(e, O(t, n));
        }
        static defaults(e) {
          return n.defaults(O(t, e)).Minimatch;
        }
      },
      AST: class extends n.AST {
        constructor(e, n, r = {}) {
          super(e, n, O(t, r));
        }
        static fromGlob(e, r = {}) {
          return n.AST.fromGlob(e, O(t, r));
        }
      },
      unescape: (e, r = {}) => n.unescape(e, O(t, r)),
      escape: (e, r = {}) => n.escape(e, O(t, r)),
      filter: (e, r = {}) => n.filter(e, O(t, r)),
      defaults: (e) => n.defaults(O(t, e)),
      makeRe: (e, r = {}) => n.makeRe(e, O(t, r)),
      braceExpand: (e, r = {}) => n.braceExpand(e, O(t, r)),
      match: (e, r, i = {}) => n.match(e, r, O(t, i)),
      sep: n.sep,
      GLOBSTAR: e.GLOBSTAR,
    });
  };
  e.minimatch.defaults = e.defaults;
  e.braceExpand = (e, r = {}) => {
    (0, n.assertValidPattern)(e);
    if (r.nobrace || !/\{(?:(?!\{).)*\}/.test(e)) {
      return [e];
    } else {
      return (0, t.expand)(e, {
        max: r.braceExpandMax,
      });
    }
  };
  e.minimatch.braceExpand = e.braceExpand;
  e.makeRe = (e, t = {}) => new A(e, t).makeRe();
  e.minimatch.makeRe = e.makeRe;
  e.match = (e, t, n = {}) => {
    let r = new A(t, n);
    e = e.filter((e) => r.match(e));
    if (r.options.nonull && !e.length) {
      e.push(t);
    }
    return e;
  };
  e.minimatch.match = e.match;
  let k = /[?*]|[+@!]\(.*?\)|\[|\]/;
  let ee = (e) => e.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, `\\$&`);
  var A = class {
    options;
    set;
    pattern;
    windowsPathsNoEscape;
    nonegate;
    negate;
    comment;
    empty;
    preserveMultipleSlashes;
    partial;
    globSet;
    globParts;
    nocase;
    isWindows;
    platform;
    windowsNoMagicRoot;
    maxGlobstarRecursion;
    regexp;
    constructor(e, t = {}) {
      (0, n.assertValidPattern)(e);
      t ||= {};
      this.options = t;
      this.maxGlobstarRecursion = t.maxGlobstarRecursion ?? 200;
      this.pattern = e;
      this.platform = t.platform || E;
      this.isWindows = this.platform === `win32`;
      this.windowsPathsNoEscape =
        !!t.windowsPathsNoEscape || t.allowWindowsEscape === false;
      if (this.windowsPathsNoEscape) {
        this.pattern = this.pattern.replace(/\\/g, `/`);
      }
      this.preserveMultipleSlashes = !!t.preserveMultipleSlashes;
      this.regexp = null;
      this.negate = false;
      this.nonegate = !!t.nonegate;
      this.comment = false;
      this.empty = false;
      this.partial = !!t.partial;
      this.nocase = !!this.options.nocase;
      this.windowsNoMagicRoot =
        t.windowsNoMagicRoot === undefined
          ? !!this.isWindows && !!this.nocase
          : t.windowsNoMagicRoot;
      this.globSet = [];
      this.globParts = [];
      this.set = [];
      this.make();
    }
    hasMagic() {
      if (this.options.magicalBraces && this.set.length > 1) {
        return true;
      }
      for (let e of this.set) {
        for (let t of e) {
          if (typeof t != `string`) {
            return true;
          }
        }
      }
      return false;
    }
    debug(...e) {}
    make() {
      let e = this.pattern;
      let t = this.options;
      if (!t.nocomment && e.charAt(0) === `#`) {
        this.comment = true;
        return;
      }
      if (!e) {
        this.empty = true;
        return;
      }
      this.parseNegate();
      this.globSet = [...new Set(this.braceExpand())];
      if (t.debug) {
        this.debug = (...e) => console.error(...e);
      }
      this.debug(this.pattern, this.globSet);
      let n = this.globSet.map((e) => this.slashSplit(e));
      this.globParts = this.preprocess(n);
      this.debug(this.pattern, this.globParts);
      let r = this.globParts.map((e, t, n) => {
        if (this.isWindows && this.windowsNoMagicRoot) {
          let t =
            e[0] === `` &&
            e[1] === `` &&
            (e[2] === `?` || !k.test(e[2])) &&
            !k.test(e[3]);
          let n = /^[a-z]:/i.test(e[0]);
          if (t) {
            return [...e.slice(0, 4), ...e.slice(4).map((e) => this.parse(e))];
          }
          if (n) {
            return [e[0], ...e.slice(1).map((e) => this.parse(e))];
          }
        }
        return e.map((e) => this.parse(e));
      });
      this.debug(this.pattern, r);
      this.set = r.filter((e) => e.indexOf(false) === -1);
      if (this.isWindows) {
        for (let e = 0; e < this.set.length; e++) {
          let t = this.set[e];
          if (
            t[0] === `` &&
            t[1] === `` &&
            this.globParts[e][2] === `?` &&
            typeof t[3] == `string` &&
            /^[a-z]:$/i.test(t[3])
          ) {
            t[2] = `?`;
          }
        }
      }
      this.debug(this.pattern, this.set);
    }
    preprocess(e) {
      if (this.options.noglobstar) {
        for (let t = 0; t < e.length; t++) {
          for (let n = 0; n < e[t].length; n++) {
            if (e[t][n] === `**`) {
              e[t][n] = `*`;
            }
          }
        }
      }
      let { optimizationLevel: t = 1 } = this.options;
      if (t >= 2) {
        e = this.firstPhasePreProcess(e);
        e = this.secondPhasePreProcess(e);
      } else {
        e =
          t >= 1 ? this.levelOneOptimize(e) : this.adjascentGlobstarOptimize(e);
      }
      return e;
    }
    adjascentGlobstarOptimize(e) {
      return e.map((e) => {
        let t = -1;
        while ((t = e.indexOf(`**`, t + 1)) !== -1) {
          let n = t;
          while (e[n + 1] === `**`) {
            n++;
          }
          if (n !== t) {
            e.splice(t, n - t);
          }
        }
        return e;
      });
    }
    levelOneOptimize(e) {
      return e.map((e) => {
        e = e.reduce((e, t) => {
          let n = e[e.length - 1];
          if (t === `**` && n === `**`) {
            return e;
          } else if (t === `..` && n && n !== `..` && n !== `.` && n !== `**`) {
            e.pop();
            return e;
          } else {
            e.push(t);
            return e;
          }
        }, []);
        if (e.length === 0) {
          return [``];
        } else {
          return e;
        }
      });
    }
    levelTwoFileOptimize(e) {
      if (!Array.isArray(e)) {
        e = this.slashSplit(e);
      }
      let t = false;
      do {
        t = false;
        if (!this.preserveMultipleSlashes) {
          for (let n = 1; n < e.length - 1; n++) {
            let r = e[n];
            if (n !== 1 || r !== `` || e[0] !== ``) {
              if (r === `.` || r === ``) {
                t = true;
                e.splice(n, 1);
                n--;
              }
            }
          }
          if (e[0] === `.` && e.length === 2 && (e[1] === `.` || e[1] === ``)) {
            t = true;
            e.pop();
          }
        }
        let n = 0;
        while ((n = e.indexOf(`..`, n + 1)) !== -1) {
          let r = e[n - 1];
          if (r && r !== `.` && r !== `..` && r !== `**`) {
            t = true;
            e.splice(n - 1, 2);
            n -= 2;
          }
        }
      } while (t);
      if (e.length === 0) {
        return [``];
      } else {
        return e;
      }
    }
    firstPhasePreProcess(e) {
      let t = false;
      do {
        t = false;
        for (let n of e) {
          let r = -1;
          while ((r = n.indexOf(`**`, r + 1)) !== -1) {
            let i = r;
            while (n[i + 1] === `**`) {
              i++;
            }
            if (i > r) {
              n.splice(r + 1, i - r);
            }
            let a = n[r + 1];
            let o = n[r + 2];
            let s = n[r + 3];
            if (
              a !== `..` ||
              !o ||
              o === `.` ||
              o === `..` ||
              !s ||
              s === `.` ||
              s === `..`
            ) {
              continue;
            }
            t = true;
            n.splice(r, 1);
            let c = n.slice(0);
            c[r] = `**`;
            e.push(c);
            r--;
          }
          if (!this.preserveMultipleSlashes) {
            for (let e = 1; e < n.length - 1; e++) {
              let r = n[e];
              if (e !== 1 || r !== `` || n[0] !== ``) {
                if (r === `.` || r === ``) {
                  t = true;
                  n.splice(e, 1);
                  e--;
                }
              }
            }
            if (
              n[0] === `.` &&
              n.length === 2 &&
              (n[1] === `.` || n[1] === ``)
            ) {
              t = true;
              n.pop();
            }
          }
          let i = 0;
          while ((i = n.indexOf(`..`, i + 1)) !== -1) {
            let e = n[i - 1];
            if (e && e !== `.` && e !== `..` && e !== `**`) {
              t = true;
              let e = i === 1 && n[i + 1] === `**` ? [`.`] : [];
              n.splice(i - 1, 2, ...e);
              if (n.length === 0) {
                n.push(``);
              }
              i -= 2;
            }
          }
        }
      } while (t);
      return e;
    }
    secondPhasePreProcess(e) {
      for (let t = 0; t < e.length - 1; t++) {
        for (let n = t + 1; n < e.length; n++) {
          let r = this.partsMatch(e[t], e[n], !this.preserveMultipleSlashes);
          if (r) {
            e[t] = [];
            e[n] = r;
            break;
          }
        }
      }
      return e.filter((e) => e.length);
    }
    partsMatch(e, t, n = false) {
      let r = 0;
      let i = 0;
      let a = [];
      let o = ``;
      while (r < e.length && i < t.length) {
        if (e[r] === t[i]) {
          a.push(o === `b` ? t[i] : e[r]);
          r++;
          i++;
        } else if (n && e[r] === `**` && t[i] === e[r + 1]) {
          a.push(e[r]);
          r++;
        } else if (n && t[i] === `**` && e[r] === t[i + 1]) {
          a.push(t[i]);
          i++;
        } else if (
          e[r] === `*` &&
          t[i] &&
          (this.options.dot || !t[i].startsWith(`.`)) &&
          t[i] !== `**`
        ) {
          if (o === `b`) {
            return false;
          }
          o = `a`;
          a.push(e[r]);
          r++;
          i++;
        } else if (
          t[i] === `*` &&
          e[r] &&
          (this.options.dot || !e[r].startsWith(`.`)) &&
          e[r] !== `**`
        ) {
          if (o === `a`) {
            return false;
          }
          o = `b`;
          a.push(t[i]);
          r++;
          i++;
        } else {
          return false;
        }
      }
      return e.length === t.length && a;
    }
    parseNegate() {
      if (this.nonegate) {
        return;
      }
      let e = this.pattern;
      let t = false;
      let n = 0;
      for (let r = 0; r < e.length && e.charAt(r) === `!`; r++) {
        t = !t;
        n++;
      }
      if (n) {
        this.pattern = e.slice(n);
      }
      this.negate = t;
    }
    matchOne(t, n, r = false) {
      let i = 0;
      let a = 0;
      if (this.isWindows) {
        let e = typeof t[0] == `string` && /^[a-z]:$/i.test(t[0]);
        let r =
          !e &&
          t[0] === `` &&
          t[1] === `` &&
          t[2] === `?` &&
          /^[a-z]:$/i.test(t[3]);
        let o = typeof n[0] == `string` && /^[a-z]:$/i.test(n[0]);
        let s =
          !o &&
          n[0] === `` &&
          n[1] === `` &&
          n[2] === `?` &&
          typeof n[3] == `string` &&
          /^[a-z]:$/i.test(n[3]);
        let c = r ? 3 : e ? 0 : undefined;
        let l = s ? 3 : o ? 0 : undefined;
        if (typeof c == `number` && typeof l == `number`) {
          let [e, r] = [t[c], n[l]];
          if (e.toLowerCase() === r.toLowerCase()) {
            n[l] = e;
            a = l;
            i = c;
          }
        }
      }
      let { optimizationLevel: o = 1 } = this.options;
      if (o >= 2) {
        t = this.levelTwoFileOptimize(t);
      }
      if (n.includes(e.GLOBSTAR)) {
        return this.#e(t, n, r, i, a);
      } else {
        return this.#n(t, n, r, i, a);
      }
    }
    #e(t, n, r, i, a) {
      let o = n.indexOf(e.GLOBSTAR, a);
      let s = n.lastIndexOf(e.GLOBSTAR);
      let [c, l, u] = r
        ? [n.slice(a, o), n.slice(o + 1), []]
        : [n.slice(a, o), n.slice(o + 1, s), n.slice(s + 1)];
      if (c.length) {
        let e = t.slice(i, i + c.length);
        if (!this.#n(e, c, r, 0, 0)) {
          return false;
        }
        i += c.length;
        a += c.length;
      }
      let d = 0;
      if (u.length) {
        if (u.length + i > t.length) {
          return false;
        }
        let e = t.length - u.length;
        if (this.#n(t, u, r, e, 0)) {
          d = u.length;
        } else {
          if (
            t[t.length - 1] !== `` ||
            i + u.length === t.length ||
            (e--, !this.#n(t, u, r, e, 0))
          ) {
            return false;
          }
          d = u.length + 1;
        }
      }
      if (!l.length) {
        let e = !!d;
        for (let n = i; n < t.length - d; n++) {
          let r = String(t[n]);
          e = true;
          if (
            r === `.` ||
            r === `..` ||
            (!this.options.dot && r.startsWith(`.`))
          ) {
            return false;
          }
        }
        return r || e;
      }
      let f = [[[], 0]];
      let p = f[0];
      let m = 0;
      let h = [0];
      for (let t of l) {
        if (t === e.GLOBSTAR) {
          h.push(m);
          p = [[], 0];
          f.push(p);
        } else {
          p[0].push(t);
          m++;
        }
      }
      let g = f.length - 1;
      let _ = t.length - d;
      for (let e of f) {
        e[1] = _ - (h[g--] + e[0].length);
      }
      return !!this.#t(t, f, i, 0, r, 0, !!d);
    }
    #t(e, t, n, r, i, a, o) {
      let s = t[r];
      if (!s) {
        for (let t = n; t < e.length; t++) {
          o = true;
          let n = e[t];
          if (
            n === `.` ||
            n === `..` ||
            (!this.options.dot && n.startsWith(`.`))
          ) {
            return false;
          }
        }
        return o;
      }
      let [c, l] = s;
      while (n <= l) {
        if (
          this.#n(e.slice(0, n + c.length), c, i, n, 0) &&
          a < this.maxGlobstarRecursion
        ) {
          let s = this.#t(e, t, n + c.length, r + 1, i, a + 1, o);
          if (s !== false) {
            return s;
          }
        }
        let s = e[n];
        if (
          s === `.` ||
          s === `..` ||
          (!this.options.dot && s.startsWith(`.`))
        ) {
          return false;
        }
        n++;
      }
      return i || null;
    }
    #n(t, n, r, i, a) {
      let o;
      let s;
      let c;
      let l;
      o = i;
      s = a;
      l = t.length;
      c = n.length;
      for (; o < l && s < c; o++, s++) {
        this.debug(`matchOne loop`);
        let r = n[s];
        let i = t[o];
        this.debug(n, r, i);
        if (r === false || r === e.GLOBSTAR) {
          return false;
        }
        let a;
        if (typeof r == `string`) {
          a = i === r;
          this.debug(`string match`, r, i, a);
        } else {
          a = r.test(i);
          this.debug(`pattern match`, r, i, a);
        }
        if (!a) {
          return false;
        }
      }
      if (o === l && s === c) {
        return true;
      }
      if (o === l) {
        return r;
      }
      if (s === c) {
        return o === l - 1 && t[o] === ``;
      }
      throw Error(`wtf?`);
    }
    braceExpand() {
      return (0, e.braceExpand)(this.pattern, this.options);
    }
    parse(t) {
      (0, n.assertValidPattern)(t);
      let i = this.options;
      if (t === `**`) {
        return e.GLOBSTAR;
      }
      if (t === ``) {
        return ``;
      }
      let a;
      let w = null;
      if ((a = t.match(g))) {
        w = i.dot ? v : _;
      } else if ((a = t.match(o))) {
        w = (i.nocase ? (i.dot ? u : l) : i.dot ? c : s)(a[1]);
      } else if ((a = t.match(y))) {
        w = (i.nocase ? (i.dot ? x : b) : i.dot ? S : C)(a);
      } else if ((a = t.match(d))) {
        w = i.dot ? p : f;
      } else if ((a = t.match(m))) {
        w = h;
      }
      let T = r.AST.fromGlob(t, this.options).toMMPattern();
      if (w && typeof T == `object`) {
        Reflect.defineProperty(T, `test`, {
          value: w,
        });
      }
      return T;
    }
    makeRe() {
      if (this.regexp || this.regexp === false) {
        return this.regexp;
      }
      let t = this.set;
      if (!t.length) {
        this.regexp = false;
        return this.regexp;
      }
      let n = this.options;
      let r = n.noglobstar
        ? `[^/]*?`
        : n.dot
          ? `(?:(?!(?:\\/|^)(?:\\.{1,2})($|\\/)).)*?`
          : `(?:(?!(?:\\/|^)\\.).)*?`;
      let i = new Set(n.nocase ? [`i`] : []);
      let a = t
        .map((t) => {
          let n = t.map((t) => {
            if (t instanceof RegExp) {
              for (let e of t.flags.split(``)) {
                i.add(e);
              }
            }
            if (typeof t == `string`) {
              return ee(t);
            } else if (t === e.GLOBSTAR) {
              return e.GLOBSTAR;
            } else {
              return t._src;
            }
          });
          n.forEach((t, i) => {
            let a = n[i + 1];
            let o = n[i - 1];
            if (t === e.GLOBSTAR && o !== e.GLOBSTAR) {
              if (o === undefined) {
                if (a !== undefined && a !== e.GLOBSTAR) {
                  n[i + 1] = `(?:\\/|${r}\\/)?${a}`;
                } else {
                  n[i] = r;
                }
              } else if (a === undefined) {
                n[i - 1] = `${o}(?:\\/|\\/${r})?`;
              } else if (a !== e.GLOBSTAR) {
                n[i - 1] = `${o}(?:\\/|\\/${r}\\/)${a}`;
                n[i + 1] = e.GLOBSTAR;
              }
            }
          });
          let a = n.filter((t) => t !== e.GLOBSTAR);
          if (this.partial && a.length >= 1) {
            let e = [];
            for (let t = 1; t <= a.length; t++) {
              e.push(a.slice(0, t).join(`/`));
            }
            return `(?:${e.join(`|`)})`;
          }
          return a.join(`/`);
        })
        .join(`|`);
      let [o, s] = t.length > 1 ? [`(?:`, `)`] : [``, ``];
      a = `^${o}${a}${s}$`;
      if (this.partial) {
        a = `^(?:\\/|${o}${a.slice(1, -1)}${s})$`;
      }
      if (this.negate) {
        a = `^(?!${a}).+$`;
      }
      try {
        this.regexp = new RegExp(a, [...i].join(``));
      } catch {
        this.regexp = false;
      }
      return this.regexp;
    }
    slashSplit(e) {
      if (this.preserveMultipleSlashes) {
        return e.split(`/`);
      } else if (this.isWindows && /^\/\/[^\/]+/.test(e)) {
        return [``, ...e.split(/\/+/)];
      } else {
        return e.split(/\/+/);
      }
    }
    match(e, t = this.partial) {
      this.debug(`match`, e, this.pattern);
      if (this.comment) {
        return false;
      }
      if (this.empty) {
        return e === ``;
      }
      if (e === `/` && t) {
        return true;
      }
      let n = this.options;
      if (this.isWindows) {
        e = e.split(`\\`).join(`/`);
      }
      let r = this.slashSplit(e);
      this.debug(this.pattern, `split`, r);
      let i = this.set;
      this.debug(this.pattern, `set`, i);
      let a = r[r.length - 1];
      if (!a) {
        for (let e = r.length - 2; !a && e >= 0; e--) {
          a = r[e];
        }
      }
      for (let e = 0; e < i.length; e++) {
        let o = i[e];
        let s = r;
        if (n.matchBase && o.length === 1) {
          s = [a];
        }
        if (this.matchOne(s, o, t)) {
          if (n.flipNegate) {
            return true;
          } else {
            return !this.negate;
          }
        }
      }
      if (n.flipNegate) {
        return false;
      } else {
        return this.negate;
      }
    }
    static defaults(t) {
      return e.minimatch.defaults(t).Minimatch;
    }
  };
  e.Minimatch = A;
  var j = xa();
  Object.defineProperty(e, `AST`, {
    enumerable: true,
    get: function () {
      return j.AST;
    },
  });
  var M = Sa();
  Object.defineProperty(e, `escape`, {
    enumerable: true,
    get: function () {
      return M.escape;
    },
  });
  var te = ba();
  Object.defineProperty(e, `unescape`, {
    enumerable: true,
    get: function () {
      return te.unescape;
    },
  });
  e.minimatch.AST = r.AST;
  e.minimatch.Minimatch = A;
  e.minimatch.escape = i.escape;
  e.minimatch.unescape = a.unescape;
});
var wa = X((e, t) => {
  let n = he(`fs`);
  let r = he(`path`);
  let i = he(`events`).EventEmitter;
  let a = Ca().Minimatch;
  var o = class e extends i {
    constructor(e) {
      e ||= {};
      super(e);
      this.isSymbolicLink = e.isSymbolicLink;
      this.path = e.path || process.cwd();
      this.basename = r.basename(this.path);
      this.ignoreFiles = e.ignoreFiles || [`.ignore`];
      this.ignoreRules = {};
      this.parent = e.parent || null;
      this.includeEmpty = !!e.includeEmpty;
      this.root = this.parent ? this.parent.root : this.path;
      this.follow = !!e.follow;
      this.result = this.parent ? this.parent.result : new Set();
      this.entries = null;
      this.sawError = false;
      this.exact = e.exact;
    }
    sort(e, t) {
      return e.localeCompare(t, `en`);
    }
    emit(e, t) {
      let n = false;
      if (!this.sawError || e !== `error`) {
        if (e === `error`) {
          this.sawError = true;
        } else if (e === `done` && !this.parent) {
          t = Array.from(t)
            .map((e) => (/^@/.test(e) ? `./${e}` : e))
            .sort(this.sort);
          this.result = t;
        }
        n =
          e === `error` && this.parent
            ? this.parent.emit(`error`, t)
            : super.emit(e, t);
      }
      return n;
    }
    start() {
      n.readdir(this.path, (e, t) =>
        e ? this.emit(`error`, e) : this.onReaddir(t),
      );
      return this;
    }
    isIgnoreFile(e) {
      return e !== `.` && e !== `..` && this.ignoreFiles.indexOf(e) !== -1;
    }
    onReaddir(e) {
      this.entries = e;
      if (e.length === 0) {
        if (this.includeEmpty) {
          this.result.add(this.path.slice(this.root.length + 1));
        }
        this.emit(`done`, this.result);
      } else if (this.entries.some((e) => this.isIgnoreFile(e))) {
        this.addIgnoreFiles();
      } else {
        this.filterEntries();
      }
    }
    addIgnoreFiles() {
      let e = this.entries.filter((e) => this.isIgnoreFile(e));
      let t = e.length;
      let n = () => {
        if (--t === 0) {
          this.filterEntries();
        }
      };
      e.forEach((e) => this.addIgnoreFile(e, n));
    }
    addIgnoreFile(e, t) {
      let i = r.resolve(this.path, e);
      n.readFile(i, `utf8`, (n, r) =>
        n ? this.emit(`error`, n) : this.onReadIgnoreFile(e, r, t),
      );
    }
    onReadIgnoreFile(e, t, n) {
      let r = {
        matchBase: true,
        dot: true,
        flipNegate: true,
        nocase: true,
      };
      let i = t
        .split(/\r?\n/)
        .filter((e) => !/^#|^$/.test(e.trim()))
        .map((e) => new a(e.trim(), r));
      this.ignoreRules[e] = i;
      n();
    }
    filterEntries() {
      let e = this.entries
        .map((e) => {
          let t = this.filterEntry(e);
          let n = this.filterEntry(e, true);
          if (t || n) {
            return [e, t, n];
          } else {
            return false;
          }
        })
        .filter((e) => e);
      let t = e.length;
      if (t === 0) {
        this.emit(`done`, this.result);
      } else {
        let n = () => {
          if (--t === 0) {
            this.emit(`done`, this.result);
          }
        };
        e.forEach((e) => {
          let t = e[0];
          let r = e[1];
          let i = e[2];
          this.stat(
            {
              entry: t,
              file: r,
              dir: i,
            },
            n,
          );
        });
      }
    }
    onstat({ st: e, entry: t, file: n, dir: r, isSymbolicLink: i }, a) {
      let o = `${this.path}/${t}`;
      if (e.isDirectory()) {
        if (r) {
          this.walker(
            t,
            {
              isSymbolicLink: i,
              exact: n || this.filterEntry(`${t}/`),
            },
            a,
          );
        } else {
          a();
        }
      } else {
        if (n) {
          this.result.add(o.slice(this.root.length + 1));
        }
        a();
      }
    }
    stat({ entry: e, file: t, dir: r }, i) {
      let a = `${this.path}/${e}`;
      n.lstat(a, (o, s) => {
        if (o) {
          this.emit(`error`, o);
        } else {
          let o = s.isSymbolicLink();
          if (this.follow && o) {
            n.stat(a, (n, a) => {
              if (n) {
                this.emit(`error`, n);
              } else {
                this.onstat(
                  {
                    st: a,
                    entry: e,
                    file: t,
                    dir: r,
                    isSymbolicLink: o,
                  },
                  i,
                );
              }
            });
          } else {
            this.onstat(
              {
                st: s,
                entry: e,
                file: t,
                dir: r,
                isSymbolicLink: o,
              },
              i,
            );
          }
        }
      });
    }
    walkerOpt(e, t) {
      return {
        path: `${this.path}/${e}`,
        parent: this,
        ignoreFiles: this.ignoreFiles,
        follow: this.follow,
        includeEmpty: this.includeEmpty,
        ...t,
      };
    }
    walker(t, n, r) {
      new e(this.walkerOpt(t, n)).on(`done`, r).start();
    }
    filterEntry(e, t, n) {
      let r = true;
      if (this.parent && this.parent.filterEntry) {
        let i = `${this.basename}/${e}`;
        let a = n || e;
        r = this.parent.filterEntry(i, t, a);
        if (!r && !this.exact) {
          return false;
        }
      }
      this.ignoreFiles.forEach((i) => {
        if (this.ignoreRules[i]) {
          this.ignoreRules[i].forEach((i) => {
            if (i.negate !== r) {
              let a =
                n &&
                i.globParts.some((e) => e.length <= (e.slice(-1)[0] ? 1 : 2));
              if (
                i.match(`/${e}`) ||
                i.match(e) ||
                (t &&
                  (i.match(`/${e}/`) ||
                    i.match(`${e}/`) ||
                    (i.negate &&
                      (i.match(`/${e}`, true) || i.match(e, true))) ||
                    (a &&
                      (i.match(`/${n}/`) ||
                        i.match(`${n}/`) ||
                        (i.negate &&
                          (i.match(`/${n}`, true) || i.match(n, true)))))))
              ) {
                r = i.negate;
              }
            }
          });
        }
      });
      return r;
    }
  };
  var s = class e extends o {
    start() {
      this.onReaddir(n.readdirSync(this.path));
      return this;
    }
    addIgnoreFile(e, t) {
      let i = r.resolve(this.path, e);
      this.onReadIgnoreFile(e, n.readFileSync(i, `utf8`), t);
    }
    stat({ entry: e, file: t, dir: r }, i) {
      let a = `${this.path}/${e}`;
      let o = n.lstatSync(a);
      let s = o.isSymbolicLink();
      if (this.follow && s) {
        o = n.statSync(a);
      }
      this.onstat(
        {
          st: o,
          entry: e,
          file: t,
          dir: r,
          isSymbolicLink: s,
        },
        i,
      );
    }
    walker(t, n, r) {
      new e(this.walkerOpt(t, n)).start();
      r();
    }
  };
  let c = (e, t) => {
    let n = new Promise((t, n) => {
      new o(e).on(`done`, t).on(`error`, n).start();
    });
    if (t) {
      return n.then((e) => t(null, e), t);
    } else {
      return n;
    }
  };
  t.exports = c;
  c.sync = (e) => new s(e).start().result;
  c.Walker = o;
  c.WalkerSync = s;
});
var Ta = X((e, t) => {
  let n = `[^\\\\/]`;
  let r = `[^/]`;
  let i = `(?:\\/|$)`;
  let a = `(?:^|\\/)`;
  let o = `\\.{1,2}${i}`;
  let s = {
    DOT_LITERAL: `\\.`,
    PLUS_LITERAL: `\\+`,
    QMARK_LITERAL: `\\?`,
    SLASH_LITERAL: `\\/`,
    ONE_CHAR: `(?=.)`,
    QMARK: r,
    END_ANCHOR: i,
    DOTS_SLASH: o,
    NO_DOT: `(?!\\.)`,
    NO_DOTS: `(?!${a}${o})`,
    NO_DOT_SLASH: `(?!\\.{0,1}${i})`,
    NO_DOTS_SLASH: `(?!${o})`,
    QMARK_NO_DOT: `[^.\\/]`,
    STAR: `${r}*?`,
    START_ANCHOR: a,
    SEP: `/`,
  };
  let c = {
    ...s,
    SLASH_LITERAL: `[\\\\/]`,
    QMARK: n,
    STAR: `${n}*?`,
    DOTS_SLASH: `\\.{1,2}(?:[\\\\/]|$)`,
    NO_DOT: `(?!\\.)`,
    NO_DOTS: `(?!(?:^|[\\\\/])\\.{1,2}(?:[\\\\/]|$))`,
    NO_DOT_SLASH: `(?!\\.{0,1}(?:[\\\\/]|$))`,
    NO_DOTS_SLASH: `(?!\\.{1,2}(?:[\\\\/]|$))`,
    QMARK_NO_DOT: `[^.\\\\/]`,
    START_ANCHOR: `(?:^|[\\\\/])`,
    END_ANCHOR: `(?:[\\\\/]|$)`,
    SEP: `\\`,
  };
  t.exports = {
    DEFAULT_MAX_EXTGLOB_RECURSION: 0,
    MAX_LENGTH: 65536,
    POSIX_REGEX_SOURCE: {
      __proto__: null,
      alnum: `a-zA-Z0-9`,
      alpha: `a-zA-Z`,
      ascii: `\\x00-\\x7F`,
      blank: ` \\t`,
      cntrl: `\\x00-\\x1F\\x7F`,
      digit: `0-9`,
      graph: `\\x21-\\x7E`,
      lower: `a-z`,
      print: `\\x20-\\x7E `,
      punct: `\\-!"#$%&'()\\*+,./:;<=>?@[\\]^_\`{|}~`,
      space: ` \\t\\r\\n\\v\\f`,
      upper: `A-Z`,
      word: `A-Za-z0-9_`,
      xdigit: `A-Fa-f0-9`,
    },
    REGEX_BACKSLASH: /\\(?![*+?^${}(|)[\]])/g,
    REGEX_NON_SPECIAL_CHARS: /^[^@![\].,$*+?^{}()|\\/]+/,
    REGEX_SPECIAL_CHARS: /[-*+?.^${}(|)[\]]/,
    REGEX_SPECIAL_CHARS_BACKREF: /(\\?)((\W)(\3*))/g,
    REGEX_SPECIAL_CHARS_GLOBAL: /([-*+?.^${}(|)[\]])/g,
    REGEX_REMOVE_BACKSLASH: /(?:\[.*?[^\\]\]|\\(?=.))/g,
    REPLACEMENTS: {
      __proto__: null,
      "***": `*`,
      "**/**": `**`,
      "**/**/**": `**`,
    },
    CHAR_0: 48,
    CHAR_9: 57,
    CHAR_UPPERCASE_A: 65,
    CHAR_LOWERCASE_A: 97,
    CHAR_UPPERCASE_Z: 90,
    CHAR_LOWERCASE_Z: 122,
    CHAR_LEFT_PARENTHESES: 40,
    CHAR_RIGHT_PARENTHESES: 41,
    CHAR_ASTERISK: 42,
    CHAR_AMPERSAND: 38,
    CHAR_AT: 64,
    CHAR_BACKWARD_SLASH: 92,
    CHAR_CARRIAGE_RETURN: 13,
    CHAR_CIRCUMFLEX_ACCENT: 94,
    CHAR_COLON: 58,
    CHAR_COMMA: 44,
    CHAR_DOT: 46,
    CHAR_DOUBLE_QUOTE: 34,
    CHAR_EQUAL: 61,
    CHAR_EXCLAMATION_MARK: 33,
    CHAR_FORM_FEED: 12,
    CHAR_FORWARD_SLASH: 47,
    CHAR_GRAVE_ACCENT: 96,
    CHAR_HASH: 35,
    CHAR_HYPHEN_MINUS: 45,
    CHAR_LEFT_ANGLE_BRACKET: 60,
    CHAR_LEFT_CURLY_BRACE: 123,
    CHAR_LEFT_SQUARE_BRACKET: 91,
    CHAR_LINE_FEED: 10,
    CHAR_NO_BREAK_SPACE: 160,
    CHAR_PERCENT: 37,
    CHAR_PLUS: 43,
    CHAR_QUESTION_MARK: 63,
    CHAR_RIGHT_ANGLE_BRACKET: 62,
    CHAR_RIGHT_CURLY_BRACE: 125,
    CHAR_RIGHT_SQUARE_BRACKET: 93,
    CHAR_SEMICOLON: 59,
    CHAR_SINGLE_QUOTE: 39,
    CHAR_SPACE: 32,
    CHAR_TAB: 9,
    CHAR_UNDERSCORE: 95,
    CHAR_VERTICAL_LINE: 124,
    CHAR_ZERO_WIDTH_NOBREAK_SPACE: 65279,
    extglobChars(e) {
      return {
        "!": {
          type: `negate`,
          open: `(?:(?!(?:`,
          close: `))${e.STAR})`,
        },
        "?": {
          type: `qmark`,
          open: `(?:`,
          close: `)?`,
        },
        "+": {
          type: `plus`,
          open: `(?:`,
          close: `)+`,
        },
        "*": {
          type: `star`,
          open: `(?:`,
          close: `)*`,
        },
        "@": {
          type: `at`,
          open: `(?:`,
          close: `)`,
        },
      };
    },
    globChars(e) {
      if (e === true) {
        return c;
      } else {
        return s;
      }
    },
  };
});
var Ea = X((e) => {
  let {
    REGEX_BACKSLASH: t,
    REGEX_REMOVE_BACKSLASH: n,
    REGEX_SPECIAL_CHARS: r,
    REGEX_SPECIAL_CHARS_GLOBAL: i,
  } = Ta();
  e.isObject = (e) => typeof e == `object` && !!e && !Array.isArray(e);
  e.hasRegexChars = (e) => r.test(e);
  e.isRegexChar = (t) => t.length === 1 && e.hasRegexChars(t);
  e.escapeRegex = (e) => e.replace(i, `\\$1`);
  e.toPosixSlashes = (e) => e.replace(t, `/`);
  e.isWindows = () => {
    if (typeof navigator < `u` && navigator.platform) {
      let e = navigator.platform.toLowerCase();
      return e === `win32` || e === `windows`;
    }
    if (typeof process < `u` && process.platform) {
      return process.platform === `win32`;
    } else {
      return false;
    }
  };
  e.removeBackslashes = (e) => e.replace(n, (e) => (e === `\\` ? `` : e));
  e.escapeLast = (t, n, r) => {
    let i = t.lastIndexOf(n, r);
    if (i === -1) {
      return t;
    } else if (t[i - 1] === `\\`) {
      return e.escapeLast(t, n, i - 1);
    } else {
      return `${t.slice(0, i)}\\${t.slice(i)}`;
    }
  };
  e.removePrefix = (e, t = {}) => {
    let n = e;
    if (n.startsWith(`./`)) {
      n = n.slice(2);
      t.prefix = `./`;
    }
    return n;
  };
  e.wrapOutput = (e, t = {}, n = {}) => {
    let r = `${n.contains ? `` : `^`}(?:${e})${n.contains ? `` : `$`}`;
    if (t.negated === true) {
      r = `(?:^(?!${r}).*$)`;
    }
    return r;
  };
  e.basename = (e, { windows: t } = {}) => {
    let n = e.split(t ? /[\\/]/ : `/`);
    let r = n[n.length - 1];
    if (r === ``) {
      return n[n.length - 2];
    } else {
      return r;
    }
  };
});
var Da = X((e, t) => {
  let n = Ea();
  let {
    CHAR_ASTERISK: r,
    CHAR_AT: i,
    CHAR_BACKWARD_SLASH: a,
    CHAR_COMMA: o,
    CHAR_DOT: s,
    CHAR_EXCLAMATION_MARK: c,
    CHAR_FORWARD_SLASH: l,
    CHAR_LEFT_CURLY_BRACE: u,
    CHAR_LEFT_PARENTHESES: d,
    CHAR_LEFT_SQUARE_BRACKET: f,
    CHAR_PLUS: p,
    CHAR_QUESTION_MARK: m,
    CHAR_RIGHT_CURLY_BRACE: h,
    CHAR_RIGHT_PARENTHESES: g,
    CHAR_RIGHT_SQUARE_BRACKET: _,
  } = Ta();
  let v = (e) => e === l || e === a;
  let y = (e) => {
    if (e.isPrefix !== true) {
      e.depth = e.isGlobstar ? Infinity : 1;
    }
  };
  t.exports = (e, t) => {
    let b = t || {};
    let x = e.length - 1;
    let S = b.parts === true || b.scanToEnd === true;
    let C = [];
    let w = [];
    let T = [];
    let E = e;
    let D = -1;
    let O = 0;
    let k = 0;
    let ee = false;
    let A = false;
    let j = false;
    let M = false;
    let te = false;
    let N = false;
    let P = false;
    let F = false;
    let I = false;
    let L = false;
    let R = 0;
    let z;
    let B;
    let V = {
      value: ``,
      depth: 0,
      isGlob: false,
    };
    let H = () => D >= x;
    let U = () => E.charCodeAt(D + 1);
    let W = () => {
      z = B;
      return E.charCodeAt(++D);
    };
    while (D < x) {
      B = W();
      let e;
      if (B === a) {
        P = V.backslashes = true;
        B = W();
        if (B === u) {
          N = true;
        }
        continue;
      }
      if (N === true || B === u) {
        for (R++; H() !== true && (B = W()); ) {
          if (B === a) {
            P = V.backslashes = true;
            W();
            continue;
          }
          if (B === u) {
            R++;
            continue;
          }
          if (N !== true && B === s && (B = W()) === s) {
            ee = V.isBrace = true;
            j = V.isGlob = true;
            L = true;
            if (S === true) {
              continue;
            }
            break;
          }
          if (N !== true && B === o) {
            ee = V.isBrace = true;
            j = V.isGlob = true;
            L = true;
            if (S === true) {
              continue;
            }
            break;
          }
          if (B === h && (R--, R === 0)) {
            N = false;
            ee = V.isBrace = true;
            L = true;
            break;
          }
        }
        if (S === true) {
          continue;
        }
        break;
      }
      if (B === l) {
        C.push(D);
        w.push(V);
        V = {
          value: ``,
          depth: 0,
          isGlob: false,
        };
        if (L === true) {
          continue;
        }
        if (z === s && D === O + 1) {
          O += 2;
          continue;
        }
        k = D + 1;
        continue;
      }
      if (
        b.noext !== true &&
        (B === p || B === i || B === r || B === m || B === c) &&
        U() === d
      ) {
        j = V.isGlob = true;
        M = V.isExtglob = true;
        L = true;
        if (B === c && D === O) {
          I = true;
        }
        if (S === true) {
          while (H() !== true && (B = W())) {
            if (B === a) {
              P = V.backslashes = true;
              B = W();
              continue;
            }
            if (B === g) {
              j = V.isGlob = true;
              L = true;
              break;
            }
          }
          continue;
        }
        break;
      }
      if (B === r) {
        if (z === r) {
          te = V.isGlobstar = true;
        }
        j = V.isGlob = true;
        L = true;
        if (S === true) {
          continue;
        }
        break;
      }
      if (B === m) {
        j = V.isGlob = true;
        L = true;
        if (S === true) {
          continue;
        }
        break;
      }
      if (B === f) {
        while (H() !== true && (e = W())) {
          if (e === a) {
            P = V.backslashes = true;
            W();
            continue;
          }
          if (e === _) {
            A = V.isBracket = true;
            j = V.isGlob = true;
            L = true;
            break;
          }
        }
        if (S === true) {
          continue;
        }
        break;
      }
      if (b.nonegate !== true && B === c && D === O) {
        F = V.negated = true;
        O++;
        continue;
      }
      if (b.noparen !== true && B === d) {
        j = V.isGlob = true;
        if (S === true) {
          while (H() !== true && (B = W())) {
            if (B === d) {
              P = V.backslashes = true;
              B = W();
              continue;
            }
            if (B === g) {
              L = true;
              break;
            }
          }
          continue;
        }
        break;
      }
      if (j === true) {
        L = true;
        if (S === true) {
          continue;
        }
        break;
      }
    }
    if (b.noext === true) {
      M = false;
      j = false;
    }
    let G = E;
    let ne = ``;
    let K = ``;
    if (O > 0) {
      ne = E.slice(0, O);
      E = E.slice(O);
      k -= O;
    }
    if (G && j === true && k > 0) {
      G = E.slice(0, k);
      K = E.slice(k);
    } else if (j === true) {
      G = ``;
      K = E;
    } else {
      G = E;
    }
    if (
      G &&
      G !== `` &&
      G !== `/` &&
      G !== E &&
      v(G.charCodeAt(G.length - 1))
    ) {
      G = G.slice(0, -1);
    }
    if (b.unescape === true) {
      K &&= n.removeBackslashes(K);
      if (G && P === true) {
        G = n.removeBackslashes(G);
      }
    }
    let q = {
      prefix: ne,
      input: e,
      start: O,
      base: G,
      glob: K,
      isBrace: ee,
      isBracket: A,
      isGlob: j,
      isExtglob: M,
      isGlobstar: te,
      negated: F,
      negatedExtglob: I,
    };
    if (b.tokens === true) {
      q.maxDepth = 0;
      if (!v(B)) {
        w.push(V);
      }
      q.tokens = w;
    }
    if (b.parts === true || b.tokens === true) {
      let t;
      for (let n = 0; n < C.length; n++) {
        let r = t ? t + 1 : O;
        let i = C[n];
        let a = e.slice(r, i);
        if (b.tokens) {
          if (n === 0 && O !== 0) {
            w[n].isPrefix = true;
            w[n].value = ne;
          } else {
            w[n].value = a;
          }
          y(w[n]);
          q.maxDepth += w[n].depth;
        }
        if (n !== 0 || a !== ``) {
          T.push(a);
        }
        t = i;
      }
      if (t && t + 1 < e.length) {
        let n = e.slice(t + 1);
        T.push(n);
        if (b.tokens) {
          w[w.length - 1].value = n;
          y(w[w.length - 1]);
          q.maxDepth += w[w.length - 1].depth;
        }
      }
      q.slashes = C;
      q.parts = T;
    }
    return q;
  };
});
var Oa = X((e, t) => {
  let n = Ta();
  let r = Ea();
  let {
    MAX_LENGTH: i,
    POSIX_REGEX_SOURCE: a,
    REGEX_NON_SPECIAL_CHARS: o,
    REGEX_SPECIAL_CHARS_BACKREF: s,
    REPLACEMENTS: c,
  } = n;
  let l = (e, t) => {
    if (typeof t.expandRange == `function`) {
      return t.expandRange(...e, t);
    }
    e.sort();
    let n = `[${e.join(`-`)}]`;
    try {
      new RegExp(n);
    } catch {
      return e.map((e) => r.escapeRegex(e)).join(`..`);
    }
    return n;
  };
  let u = (e, t) =>
    `Missing ${e}: "${t}" - use "\\\\${t}" to match literal characters`;
  let d = (e) => {
    let t = [];
    let n = 0;
    let r = 0;
    let i = 0;
    let a = ``;
    let o = false;
    for (let s of e) {
      if (o === true) {
        a += s;
        o = false;
        continue;
      }
      if (s === `\\`) {
        a += s;
        o = true;
        continue;
      }
      if (s === `"`) {
        i = i === 1 ? 0 : 1;
        a += s;
        continue;
      }
      if (i === 0) {
        if (s === `[`) {
          n++;
        } else if (s === `]` && n > 0) {
          n--;
        } else if (n === 0) {
          if (s === `(`) {
            r++;
          } else if (s === `)` && r > 0) {
            r--;
          } else if (s === `|` && r === 0) {
            t.push(a);
            a = ``;
            continue;
          }
        }
      }
      a += s;
    }
    t.push(a);
    return t;
  };
  let f = (e) => {
    let t = false;
    for (let n of e) {
      if (t === true) {
        t = false;
        continue;
      }
      if (n === `\\`) {
        t = true;
        continue;
      }
      if (/[?*+@!()[\]{}]/.test(n)) {
        return false;
      }
    }
    return true;
  };
  let p = (e) => {
    let t = e.trim();
    let n = true;
    while (n === true) {
      n = false;
      if (/^@\([^\\()[\]{}|]+\)$/.test(t)) {
        t = t.slice(2, -1);
        n = true;
      }
    }
    if (f(t)) {
      return t.replace(/\\(.)/g, `$1`);
    }
  };
  let m = (e) => {
    let t = e.map(p).filter(Boolean);
    for (let e = 0; e < t.length; e++) {
      for (let n = e + 1; n < t.length; n++) {
        let r = t[e];
        let i = t[n];
        let a = r[0];
        if (
          !!a &&
          r === a.repeat(r.length) &&
          i === a.repeat(i.length) &&
          (r === i || r.startsWith(i) || i.startsWith(r))
        ) {
          return true;
        }
      }
    }
    return false;
  };
  let h = (e, t = true) => {
    if ((e[0] !== `+` && e[0] !== `*`) || e[1] !== `(`) {
      return;
    }
    let n = 0;
    let r = 0;
    let i = 0;
    let a = false;
    for (let o = 1; o < e.length; o++) {
      let s = e[o];
      if (a === true) {
        a = false;
        continue;
      }
      if (s === `\\`) {
        a = true;
        continue;
      }
      if (s === `"`) {
        i = i === 1 ? 0 : 1;
        continue;
      }
      if (i !== 1) {
        if (s === `[`) {
          n++;
          continue;
        }
        if (s === `]` && n > 0) {
          n--;
          continue;
        }
        if (!(n > 0)) {
          if (s === `(`) {
            r++;
            continue;
          }
          if (s === `)` && (r--, r === 0)) {
            if (t === true && o !== e.length - 1) {
              return undefined;
            } else {
              return {
                type: e[0],
                body: e.slice(2, o),
                end: o,
              };
            }
          }
        }
      }
    }
  };
  let g = (e) => {
    let t = 0;
    let n = [];
    while (t < e.length) {
      let r = h(e.slice(t), false);
      if (!r || r.type !== `*`) {
        return;
      }
      let i = d(r.body).map((e) => e.trim());
      if (i.length !== 1) {
        return;
      }
      let a = p(i[0]);
      if (!a || a.length !== 1) {
        return;
      }
      n.push(a);
      t += r.end + 1;
    }
    if (!(n.length < 1)) {
      return `${n.length === 1 ? r.escapeRegex(n[0]) : `[${n.map((e) => r.escapeRegex(e)).join(``)}]`}*`;
    }
  };
  let _ = (e) => {
    let t = 0;
    let n = e.trim();
    let r = h(n);
    while (r) {
      t++;
      n = r.body.trim();
      r = h(n);
    }
    return t;
  };
  let v = (e, t) => {
    if (t.maxExtglobRecursion === false) {
      return {
        risky: false,
      };
    }
    let r =
      typeof t.maxExtglobRecursion == `number`
        ? t.maxExtglobRecursion
        : n.DEFAULT_MAX_EXTGLOB_RECURSION;
    let i = d(e).map((e) => e.trim());
    if (
      i.length > 1 &&
      (i.some((e) => e === ``) || i.some((e) => /^[*?]+$/.test(e)) || m(i))
    ) {
      return {
        risky: true,
      };
    }
    for (let e of i) {
      let t = g(e);
      if (t) {
        return {
          risky: true,
          safeOutput: t,
        };
      }
      if (_(e) > r) {
        return {
          risky: true,
        };
      }
    }
    return {
      risky: false,
    };
  };
  let y = (e, t) => {
    if (typeof e != `string`) {
      throw TypeError(`Expected a string`);
    }
    e = c[e] || e;
    let d = {
      ...t,
    };
    let f = typeof d.maxLength == `number` ? Math.min(i, d.maxLength) : i;
    let p = e.length;
    if (p > f) {
      throw SyntaxError(
        `Input length: ${p}, exceeds maximum allowed length: ${f}`,
      );
    }
    let m = {
      type: `bos`,
      value: ``,
      output: d.prepend || ``,
    };
    let h = [m];
    let g = d.capture ? `` : `?:`;
    let _ = n.globChars(d.windows);
    let b = n.extglobChars(_);
    let {
      DOT_LITERAL: x,
      PLUS_LITERAL: S,
      SLASH_LITERAL: C,
      ONE_CHAR: w,
      DOTS_SLASH: T,
      NO_DOT: E,
      NO_DOT_SLASH: D,
      NO_DOTS_SLASH: O,
      QMARK: k,
      QMARK_NO_DOT: ee,
      STAR: A,
      START_ANCHOR: j,
    } = _;
    let M = (e) => `(${g}(?:(?!${j}${e.dot ? T : x}).)*?)`;
    let te = d.dot ? `` : E;
    let N = d.dot ? k : ee;
    let P = d.bash === true ? M(d) : A;
    if (d.capture) {
      P = `(${P})`;
    }
    if (typeof d.noext == `boolean`) {
      d.noextglob = d.noext;
    }
    let F = {
      input: e,
      index: -1,
      start: 0,
      dot: d.dot === true,
      consumed: ``,
      output: ``,
      prefix: ``,
      backtrack: false,
      negated: false,
      brackets: 0,
      braces: 0,
      parens: 0,
      quotes: 0,
      globstar: false,
      tokens: h,
    };
    e = r.removePrefix(e, F);
    p = e.length;
    let I = [];
    let L = [];
    let R = [];
    let z = m;
    let B;
    let V = () => F.index === p - 1;
    let H = (F.peek = (t = 1) => e[F.index + t]);
    let U = (F.advance = () => e[++F.index] || ``);
    let W = () => e.slice(F.index + 1);
    let G = (e = ``, t = 0) => {
      F.consumed += e;
      F.index += t;
    };
    let ne = (e) => {
      F.output += e.output == null ? e.value : e.output;
      G(e.value);
    };
    let K = () => {
      let e = 1;
      while (H() === `!` && (H(2) !== `(` || H(3) === `?`)) {
        U();
        F.start++;
        e++;
      }
      if (e % 2 == 0) {
        return false;
      } else {
        F.negated = true;
        F.start++;
        return true;
      }
    };
    let q = (e) => {
      F[e]++;
      R.push(e);
    };
    let J = (e) => {
      F[e]--;
      R.pop();
    };
    let Y = (e) => {
      if (z.type === `globstar`) {
        let t = F.braces > 0 && (e.type === `comma` || e.type === `brace`);
        let n =
          e.extglob === true ||
          (I.length && (e.type === `pipe` || e.type === `paren`));
        if (e.type !== `slash` && e.type !== `paren` && !t && !n) {
          F.output = F.output.slice(0, -z.output.length);
          z.type = `star`;
          z.value = `*`;
          z.output = P;
          F.output += z.output;
        }
      }
      if (I.length && e.type !== `paren`) {
        I[I.length - 1].inner += e.value;
      }
      if (e.value || e.output) {
        ne(e);
      }
      if (z && z.type === `text` && e.type === `text`) {
        z.output = (z.output || z.value) + e.value;
        z.value += e.value;
        return;
      }
      e.prev = z;
      h.push(e);
      z = e;
    };
    let re = (e, t) => {
      let n = {
        ...b[t],
        conditions: 1,
        inner: ``,
      };
      n.prev = z;
      n.parens = F.parens;
      n.output = F.output;
      n.startIndex = F.index;
      n.tokensIndex = h.length;
      let r = (d.capture ? `(` : ``) + n.open;
      q(`parens`);
      Y({
        type: e,
        value: t,
        output: F.output ? `` : w,
      });
      Y({
        type: `paren`,
        extglob: true,
        value: U(),
        output: r,
      });
      I.push(n);
    };
    let ie = (n) => {
      let i = e.slice(n.startIndex, F.index + 1);
      let a = v(e.slice(n.startIndex + 2, F.index), d);
      if ((n.type === `plus` || n.type === `star`) && a.risky) {
        let e = a.safeOutput
          ? (n.output ? `` : w) +
            (d.capture ? `(${a.safeOutput})` : a.safeOutput)
          : undefined;
        let t = h[n.tokensIndex];
        t.type = `text`;
        t.value = i;
        t.output = e || r.escapeRegex(i);
        for (let e = n.tokensIndex + 1; e < h.length; e++) {
          h[e].value = ``;
          h[e].output = ``;
          delete h[e].suffix;
        }
        F.output = n.output + t.output;
        F.backtrack = true;
        Y({
          type: `paren`,
          extglob: true,
          value: B,
          output: ``,
        });
        J(`parens`);
        return;
      }
      let o = n.close + (d.capture ? `)` : ``);
      let s;
      if (n.type === `negate`) {
        let e = P;
        if (n.inner && n.inner.length > 1 && n.inner.includes(`/`)) {
          e = M(d);
        }
        if (e !== P || V() || /^\)+$/.test(W())) {
          o = n.close = `)$))${e}`;
        }
        if (n.inner.includes(`*`) && (s = W()) && /^\.[^\\/.]+$/.test(s)) {
          o = n.close = `)${
            y(s, {
              ...t,
              fastpaths: false,
            }).output
          })${e})`;
        }
        if (n.prev.type === `bos`) {
          F.negatedExtglob = true;
        }
      }
      Y({
        type: `paren`,
        extglob: true,
        value: B,
        output: o,
      });
      J(`parens`);
    };
    if (d.fastpaths !== false && !/(^[*!]|[/()[\]{}"])/.test(e)) {
      let n = false;
      let i = e.replace(s, (e, t, r, i, a, o) =>
        i === `\\`
          ? ((n = true), e)
          : i === `?`
            ? t
              ? t + i + (a ? k.repeat(a.length) : ``)
              : o === 0
                ? N + (a ? k.repeat(a.length) : ``)
                : k.repeat(r.length)
            : i === `.`
              ? x.repeat(r.length)
              : i === `*`
                ? t
                  ? t + i + (a ? P : ``)
                  : P
                : t
                  ? e
                  : `\\${e}`,
      );
      if (n === true) {
        i =
          d.unescape === true
            ? i.replace(/\\/g, ``)
            : i.replace(/\\+/g, (e) =>
                e.length % 2 == 0 ? `\\\\` : e ? `\\` : ``,
              );
      }
      if (i === e && d.contains === true) {
        F.output = e;
        return F;
      } else {
        F.output = r.wrapOutput(i, F, t);
        return F;
      }
    }
    while (!V()) {
      B = U();
      if (B === `\0`) {
        continue;
      }
      if (B === `\\`) {
        let e = H();
        if ((e === `/` && d.bash !== true) || e === `.` || e === `;`) {
          continue;
        }
        if (!e) {
          B += `\\`;
          Y({
            type: `text`,
            value: B,
          });
          continue;
        }
        let t = /^\\+/.exec(W());
        let n = 0;
        if (t && t[0].length > 2) {
          n = t[0].length;
          F.index += n;
          if (n % 2 != 0) {
            B += `\\`;
          }
        }
        if (d.unescape === true) {
          B = U();
        } else {
          B += U();
        }
        if (F.brackets === 0) {
          Y({
            type: `text`,
            value: B,
          });
          continue;
        }
      }
      if (
        F.brackets > 0 &&
        (B !== `]` || z.value === `[` || z.value === `[^`)
      ) {
        if (d.posix !== false && B === `:`) {
          let e = z.value.slice(1);
          if (e.includes(`[`) && ((z.posix = true), e.includes(`:`))) {
            let e = z.value.lastIndexOf(`[`);
            let t = z.value.slice(0, e);
            let n = a[z.value.slice(e + 2)];
            if (n) {
              z.value = t + n;
              F.backtrack = true;
              U();
              if (!m.output && h.indexOf(z) === 1) {
                m.output = w;
              }
              continue;
            }
          }
        }
        if ((B === `[` && H() !== `:`) || (B === `-` && H() === `]`)) {
          B = `\\${B}`;
        }
        if (B === `]` && (z.value === `[` || z.value === `[^`)) {
          B = `\\${B}`;
        }
        if (d.posix === true && B === `!` && z.value === `[`) {
          B = `^`;
        }
        z.value += B;
        ne({
          value: B,
        });
        continue;
      }
      if (F.quotes === 1 && B !== `"`) {
        B = r.escapeRegex(B);
        z.value += B;
        ne({
          value: B,
        });
        continue;
      }
      if (B === `"`) {
        F.quotes = F.quotes === 1 ? 0 : 1;
        if (d.keepQuotes === true) {
          Y({
            type: `text`,
            value: B,
          });
        }
        continue;
      }
      if (B === `(`) {
        q(`parens`);
        Y({
          type: `paren`,
          value: B,
        });
        continue;
      }
      if (B === `)`) {
        if (F.parens === 0 && d.strictBrackets === true) {
          throw SyntaxError(u(`opening`, `(`));
        }
        let e = I[I.length - 1];
        if (e && F.parens === e.parens + 1) {
          ie(I.pop());
          continue;
        }
        Y({
          type: `paren`,
          value: B,
          output: F.parens ? `)` : `\\)`,
        });
        J(`parens`);
        continue;
      }
      if (B === `[`) {
        if (d.nobracket === true || !W().includes(`]`)) {
          if (d.nobracket !== true && d.strictBrackets === true) {
            throw SyntaxError(u(`closing`, `]`));
          }
          B = `\\${B}`;
        } else {
          q(`brackets`);
        }
        Y({
          type: `bracket`,
          value: B,
        });
        continue;
      }
      if (B === `]`) {
        if (
          d.nobracket === true ||
          (z && z.type === `bracket` && z.value.length === 1)
        ) {
          Y({
            type: `text`,
            value: B,
            output: `\\${B}`,
          });
          continue;
        }
        if (F.brackets === 0) {
          if (d.strictBrackets === true) {
            throw SyntaxError(u(`opening`, `[`));
          }
          Y({
            type: `text`,
            value: B,
            output: `\\${B}`,
          });
          continue;
        }
        J(`brackets`);
        let e = z.value.slice(1);
        if (z.posix !== true && e[0] === `^` && !e.includes(`/`)) {
          B = `/${B}`;
        }
        z.value += B;
        ne({
          value: B,
        });
        if (d.literalBrackets === false || r.hasRegexChars(e)) {
          continue;
        }
        let t = r.escapeRegex(z.value);
        F.output = F.output.slice(0, -z.value.length);
        if (d.literalBrackets === true) {
          F.output += t;
          z.value = t;
          continue;
        }
        z.value = `(${g}${t}|${z.value})`;
        F.output += z.value;
        continue;
      }
      if (B === `{` && d.nobrace !== true) {
        q(`braces`);
        let e = {
          type: `brace`,
          value: B,
          output: `(`,
          outputIndex: F.output.length,
          tokensIndex: F.tokens.length,
        };
        L.push(e);
        Y(e);
        continue;
      }
      if (B === `}`) {
        let e = L[L.length - 1];
        if (d.nobrace === true || !e) {
          Y({
            type: `text`,
            value: B,
            output: B,
          });
          continue;
        }
        let t = `)`;
        if (e.dots === true) {
          let e = h.slice();
          let n = [];
          for (
            let t = e.length - 1;
            t >= 0 && (h.pop(), e[t].type !== `brace`);
            t--
          ) {
            if (e[t].type !== `dots`) {
              n.unshift(e[t].value);
            }
          }
          t = l(n, d);
          F.backtrack = true;
        }
        if (e.comma !== true && e.dots !== true) {
          let n = F.output.slice(0, e.outputIndex);
          let r = F.tokens.slice(e.tokensIndex);
          e.value = e.output = `\\{`;
          B = t = `\\}`;
          F.output = n;
          for (let e of r) {
            F.output += e.output || e.value;
          }
        }
        Y({
          type: `brace`,
          value: B,
          output: t,
        });
        J(`braces`);
        L.pop();
        continue;
      }
      if (B === `|`) {
        if (I.length > 0) {
          I[I.length - 1].conditions++;
        }
        Y({
          type: `text`,
          value: B,
        });
        continue;
      }
      if (B === `,`) {
        let e = B;
        let t = L[L.length - 1];
        if (t && R[R.length - 1] === `braces`) {
          t.comma = true;
          e = `|`;
        }
        Y({
          type: `comma`,
          value: B,
          output: e,
        });
        continue;
      }
      if (B === `/`) {
        if (z.type === `dot` && F.index === F.start + 1) {
          F.start = F.index + 1;
          F.consumed = ``;
          F.output = ``;
          h.pop();
          z = m;
          continue;
        }
        Y({
          type: `slash`,
          value: B,
          output: C,
        });
        continue;
      }
      if (B === `.`) {
        if (F.braces > 0 && z.type === `dot`) {
          if (z.value === `.`) {
            z.output = x;
          }
          let e = L[L.length - 1];
          z.type = `dots`;
          z.output += B;
          z.value += B;
          e.dots = true;
          continue;
        }
        if (
          F.braces + F.parens === 0 &&
          z.type !== `bos` &&
          z.type !== `slash`
        ) {
          Y({
            type: `text`,
            value: B,
            output: x,
          });
          continue;
        }
        Y({
          type: `dot`,
          value: B,
          output: x,
        });
        continue;
      }
      if (B === `?`) {
        if (
          (!z || z.value !== `(`) &&
          d.noextglob !== true &&
          H() === `(` &&
          H(2) !== `?`
        ) {
          re(`qmark`, B);
          continue;
        }
        if (z && z.type === `paren`) {
          let e = H();
          let t = B;
          if (
            (z.value === `(` && !/[!=<:]/.test(e)) ||
            (e === `<` && !/<([!=]|\w+>)/.test(W()))
          ) {
            t = `\\${B}`;
          }
          Y({
            type: `text`,
            value: B,
            output: t,
          });
          continue;
        }
        if (d.dot !== true && (z.type === `slash` || z.type === `bos`)) {
          Y({
            type: `qmark`,
            value: B,
            output: ee,
          });
          continue;
        }
        Y({
          type: `qmark`,
          value: B,
          output: k,
        });
        continue;
      }
      if (B === `!`) {
        if (
          d.noextglob !== true &&
          H() === `(` &&
          (H(2) !== `?` || !/[!=<:]/.test(H(3)))
        ) {
          re(`negate`, B);
          continue;
        }
        if (d.nonegate !== true && F.index === 0) {
          K();
          continue;
        }
      }
      if (B === `+`) {
        if (d.noextglob !== true && H() === `(` && H(2) !== `?`) {
          re(`plus`, B);
          continue;
        }
        if ((z && z.value === `(`) || d.regex === false) {
          Y({
            type: `plus`,
            value: B,
            output: S,
          });
          continue;
        }
        if (
          (z &&
            (z.type === `bracket` ||
              z.type === `paren` ||
              z.type === `brace`)) ||
          F.parens > 0
        ) {
          Y({
            type: `plus`,
            value: B,
          });
          continue;
        }
        Y({
          type: `plus`,
          value: S,
        });
        continue;
      }
      if (B === `@`) {
        if (d.noextglob !== true && H() === `(` && H(2) !== `?`) {
          Y({
            type: `at`,
            extglob: true,
            value: B,
            output: ``,
          });
          continue;
        }
        Y({
          type: `text`,
          value: B,
        });
        continue;
      }
      if (B !== `*`) {
        if (B === `$` || B === `^`) {
          B = `\\${B}`;
        }
        let e = o.exec(W());
        if (e) {
          B += e[0];
          F.index += e[0].length;
        }
        Y({
          type: `text`,
          value: B,
        });
        continue;
      }
      if (z && (z.type === `globstar` || z.star === true)) {
        z.type = `star`;
        z.star = true;
        z.value += B;
        z.output = P;
        F.backtrack = true;
        F.globstar = true;
        G(B);
        continue;
      }
      let t = W();
      if (d.noextglob !== true && /^\([^?]/.test(t)) {
        re(`star`, B);
        continue;
      }
      if (z.type === `star`) {
        if (d.noglobstar === true) {
          G(B);
          continue;
        }
        let n = z.prev;
        let r = n.prev;
        let i = n.type === `slash` || n.type === `bos`;
        let a = r && (r.type === `star` || r.type === `globstar`);
        if (d.bash === true && (!i || (t[0] && t[0] !== `/`))) {
          Y({
            type: `star`,
            value: B,
            output: ``,
          });
          continue;
        }
        let o = F.braces > 0 && (n.type === `comma` || n.type === `brace`);
        let s = I.length && (n.type === `pipe` || n.type === `paren`);
        if (!i && n.type !== `paren` && !o && !s) {
          Y({
            type: `star`,
            value: B,
            output: ``,
          });
          continue;
        }
        while (t.slice(0, 3) === `/**`) {
          let n = e[F.index + 4];
          if (n && n !== `/`) {
            break;
          }
          t = t.slice(3);
          G(`/**`, 3);
        }
        if (n.type === `bos` && V()) {
          z.type = `globstar`;
          z.value += B;
          z.output = M(d);
          F.output = z.output;
          F.globstar = true;
          G(B);
          continue;
        }
        if (n.type === `slash` && n.prev.type !== `bos` && !a && V()) {
          F.output = F.output.slice(0, -(n.output + z.output).length);
          n.output = `(?:${n.output}`;
          z.type = `globstar`;
          z.output = M(d) + (d.strictSlashes ? `)` : `|$)`);
          z.value += B;
          F.globstar = true;
          F.output += n.output + z.output;
          G(B);
          continue;
        }
        if (n.type === `slash` && n.prev.type !== `bos` && t[0] === `/`) {
          let e = t[1] === undefined ? `` : `|$`;
          F.output = F.output.slice(0, -(n.output + z.output).length);
          n.output = `(?:${n.output}`;
          z.type = `globstar`;
          z.output = `${M(d)}${C}|${C}${e})`;
          z.value += B;
          F.output += n.output + z.output;
          F.globstar = true;
          G(B + U());
          Y({
            type: `slash`,
            value: `/`,
            output: ``,
          });
          continue;
        }
        if (n.type === `bos` && t[0] === `/`) {
          z.type = `globstar`;
          z.value += B;
          z.output = `(?:^|${C}|${M(d)}${C})`;
          F.output = z.output;
          F.globstar = true;
          G(B + U());
          Y({
            type: `slash`,
            value: `/`,
            output: ``,
          });
          continue;
        }
        F.output = F.output.slice(0, -z.output.length);
        z.type = `globstar`;
        z.output = M(d);
        z.value += B;
        F.output += z.output;
        F.globstar = true;
        G(B);
        continue;
      }
      let n = {
        type: `star`,
        value: B,
        output: P,
      };
      if (d.bash === true) {
        n.output = `.*?`;
        if (z.type === `bos` || z.type === `slash`) {
          n.output = te + n.output;
        }
        Y(n);
        continue;
      }
      if (
        z &&
        (z.type === `bracket` || z.type === `paren`) &&
        d.regex === true
      ) {
        n.output = B;
        Y(n);
        continue;
      }
      if (F.index === F.start || z.type === `slash` || z.type === `dot`) {
        if (z.type === `dot`) {
          F.output += D;
          z.output += D;
        } else if (d.dot === true) {
          F.output += O;
          z.output += O;
        } else {
          F.output += te;
          z.output += te;
        }
        if (H() !== `*`) {
          F.output += w;
          z.output += w;
        }
      }
      Y(n);
    }
    while (F.brackets > 0) {
      if (d.strictBrackets === true) {
        throw SyntaxError(u(`closing`, `]`));
      }
      F.output = r.escapeLast(F.output, `[`);
      J(`brackets`);
    }
    while (F.parens > 0) {
      if (d.strictBrackets === true) {
        throw SyntaxError(u(`closing`, `)`));
      }
      F.output = r.escapeLast(F.output, `(`);
      J(`parens`);
    }
    while (F.braces > 0) {
      if (d.strictBrackets === true) {
        throw SyntaxError(u(`closing`, `}`));
      }
      F.output = r.escapeLast(F.output, `{`);
      J(`braces`);
    }
    if (
      d.strictSlashes !== true &&
      (z.type === `star` || z.type === `bracket`)
    ) {
      Y({
        type: `maybe_slash`,
        value: ``,
        output: `${C}?`,
      });
    }
    if (F.backtrack === true) {
      F.output = ``;
      for (let e of F.tokens) {
        F.output += e.output == null ? e.value : e.output;
        if (e.suffix) {
          F.output += e.suffix;
        }
      }
    }
    return F;
  };
  y.fastpaths = (e, t) => {
    let a = {
      ...t,
    };
    let o = typeof a.maxLength == `number` ? Math.min(i, a.maxLength) : i;
    let s = e.length;
    if (s > o) {
      throw SyntaxError(
        `Input length: ${s}, exceeds maximum allowed length: ${o}`,
      );
    }
    e = c[e] || e;
    let {
      DOT_LITERAL: l,
      SLASH_LITERAL: u,
      ONE_CHAR: d,
      DOTS_SLASH: f,
      NO_DOT: p,
      NO_DOTS: m,
      NO_DOTS_SLASH: h,
      STAR: g,
      START_ANCHOR: _,
    } = n.globChars(a.windows);
    let v = a.dot ? m : p;
    let y = a.dot ? h : p;
    let b = a.capture ? `` : `?:`;
    let x = {
      negated: false,
      prefix: ``,
    };
    let S = a.bash === true ? `.*?` : g;
    if (a.capture) {
      S = `(${S})`;
    }
    let C = (e) =>
      e.noglobstar === true ? S : `(${b}(?:(?!${_}${e.dot ? f : l}).)*?)`;
    let w = (e) => {
      switch (e) {
        case `*`:
          return `${v}${d}${S}`;
        case `.*`:
          return `${l}${d}${S}`;
        case `*.*`:
          return `${v}${S}${l}${d}${S}`;
        case `*/*`:
          return `${v}${S}${u}${d}${y}${S}`;
        case `**`:
          return v + C(a);
        case `**/*`:
          return `(?:${v}${C(a)}${u})?${y}${d}${S}`;
        case `**/*.*`:
          return `(?:${v}${C(a)}${u})?${y}${S}${l}${d}${S}`;
        case `**/.*`:
          return `(?:${v}${C(a)}${u})?${l}${d}${S}`;
        default: {
          let t = /^(.*?)\.(\w+)$/.exec(e);
          if (!t) {
            return;
          }
          let n = w(t[1]);
          if (n) {
            return n + l + t[2];
          } else {
            return undefined;
          }
        }
      }
    };
    let T = w(r.removePrefix(e, x));
    if (T && a.strictSlashes !== true) {
      T += `${u}?`;
    }
    return T;
  };
  t.exports = y;
});
var ka = X((e, t) => {
  let n = Da();
  let r = Oa();
  let i = Ea();
  let a = Ta();
  let o = (e) => e && typeof e == `object` && !Array.isArray(e);
  let s = (e, t, n = false) => {
    if (Array.isArray(e)) {
      let r = e.map((e) => s(e, t, n));
      return (e) => {
        for (let t of r) {
          let n = t(e);
          if (n) {
            return n;
          }
        }
        return false;
      };
    }
    let r = o(e) && e.tokens && e.input;
    if (e === `` || (typeof e != `string` && !r)) {
      throw TypeError(`Expected pattern to be a non-empty string`);
    }
    let i = t || {};
    let a = i.windows;
    let c = r ? s.compileRe(e, t) : s.makeRe(e, t, false, true);
    let l = c.state;
    delete c.state;
    let u = () => false;
    if (i.ignore) {
      let e = {
        ...t,
        ignore: null,
        onMatch: null,
        onResult: null,
      };
      u = s(i.ignore, e, n);
    }
    let d = (n, r = false) => {
      let {
        isMatch: o,
        match: d,
        output: f,
      } = s.test(n, c, t, {
        glob: e,
        posix: a,
      });
      let p = {
        glob: e,
        state: l,
        regex: c,
        posix: a,
        input: n,
        output: f,
        match: d,
        isMatch: o,
      };
      if (typeof i.onResult == `function`) {
        i.onResult(p);
      }
      if (o === false) {
        p.isMatch = false;
        if (r) {
          return p;
        } else {
          return false;
        }
      } else if (u(n)) {
        if (typeof i.onIgnore == `function`) {
          i.onIgnore(p);
        }
        p.isMatch = false;
        if (r) {
          return p;
        } else {
          return false;
        }
      } else {
        if (typeof i.onMatch == `function`) {
          i.onMatch(p);
        }
        if (r) {
          return p;
        } else {
          return true;
        }
      }
    };
    if (n) {
      d.state = l;
    }
    return d;
  };
  s.test = (e, t, n, { glob: r, posix: a } = {}) => {
    if (typeof e != `string`) {
      throw TypeError(`Expected input to be a string`);
    }
    if (e === ``) {
      return {
        isMatch: false,
        output: ``,
      };
    }
    let o = n || {};
    let c = o.format || (a ? i.toPosixSlashes : null);
    let l = e === r;
    let u = l && c ? c(e) : e;
    if (l === false) {
      u = c ? c(e) : e;
      l = u === r;
    }
    if (l === false || o.capture === true) {
      l =
        o.matchBase === true || o.basename === true
          ? s.matchBase(e, t, n, a)
          : t.exec(u);
    }
    return {
      isMatch: !!l,
      match: l,
      output: u,
    };
  };
  s.matchBase = (e, t, n) =>
    (t instanceof RegExp ? t : s.makeRe(t, n)).test(i.basename(e));
  s.isMatch = (e, t, n) => s(t, n)(e);
  s.parse = (e, t) =>
    Array.isArray(e)
      ? e.map((e) => s.parse(e, t))
      : r(e, {
          ...t,
          fastpaths: false,
        });
  s.scan = (e, t) => n(e, t);
  s.compileRe = (e, t, n = false, r = false) => {
    if (n === true) {
      return e.output;
    }
    let i = t || {};
    let a = i.contains ? `` : `^`;
    let o = i.contains ? `` : `$`;
    let c = `${a}(?:${e.output})${o}`;
    if (e && e.negated === true) {
      c = `^(?!${c}).*$`;
    }
    let l = s.toRegex(c, t);
    if (r === true) {
      l.state = e;
    }
    return l;
  };
  s.makeRe = (e, t = {}, n = false, i = false) => {
    if (!e || typeof e != `string`) {
      throw TypeError(`Expected a non-empty string`);
    }
    let a = {
      negated: false,
      fastpaths: true,
    };
    if (t.fastpaths !== false && (e[0] === `.` || e[0] === `*`)) {
      a.output = r.fastpaths(e, t);
    }
    if (!a.output) {
      a = r(e, t);
    }
    return s.compileRe(a, t, n, i);
  };
  s.toRegex = (e, t) => {
    try {
      let n = t || {};
      return new RegExp(e, n.flags || (n.nocase ? `i` : ``));
    } catch (e) {
      if (t && t.debug === true) {
        throw e;
      }
      return /$^/;
    }
  };
  s.constants = a;
  t.exports = s;
});
var Aa = X((e, t) => {
  let n = ka();
  let r = Ea();
  function i(e, t, i = false) {
    if (t && (t.windows === null || t.windows === undefined)) {
      t = {
        ...t,
        windows: r.isWindows(),
      };
    }
    return n(e, t, i);
  }
  Object.assign(i, n);
  t.exports = i;
});
var ja = me(wa(), 1);
var Ma = me(Aa(), 1);
const Na = new Set([`.git`, `node_modules`, `dist`, `vendor`, `target`]);
async function Pa(e, t = {}) {
  if (!F.existsSync(e)) {
    return [];
  }
  let n = await (0, ja.default)({
    path: e,
    ignoreFiles: t.respectGitIgnore === false ? [] : [`.gitignore`],
    follow: false,
  });
  let r = t.pattern?.trim();
  return (
    r
      ? n.filter((e) =>
          Ma.default.isMatch(e, r, {
            dot: true,
          }),
        )
      : n
  )
    .filter((e) => !e.split(`/`).some((e) => Na.has(e)))
    .sort((e, t) => e.localeCompare(t))
    .slice(0, t.limit);
}
const Fa = (e) => {
  let t = Number.parseInt(e, 10);
  if (Number.isFinite(t)) {
    return t;
  } else {
    return 0;
  }
};
const Ia = (e) => {
  let t = e.split(`\0`);
  let n = [];
  for (let e = 0; e < t.length; e += 1) {
    let r = t[e];
    if (!r) {
      continue;
    }
    let [i, a, ...o] = r.split(`	`);
    let s = o.join(`	`);
    if (s) {
      n.push({
        path: s,
        headPath: s,
        currentPath: s,
        additions: Fa(i || ``),
        deletions: Fa(a || ``),
      });
      continue;
    }
    let c = t[e + 1] || null;
    let l = t[e + 2] || null;
    e += 2;
    n.push({
      path: c && l ? `${c} => ${l}` : l || c || ``,
      headPath: c,
      currentPath: l,
      additions: Fa(i || ``),
      deletions: Fa(a || ``),
    });
  }
  return n;
};
const La = (e) => {
  if (e.startsWith(`R`)) {
    return `renamed`;
  }
  if (e.startsWith(`C`)) {
    return `copied`;
  }
  switch (e[0]) {
    case `A`:
      return `added`;
    case `D`:
      return `deleted`;
    case `M`:
      return `modified`;
    case `T`:
      return `type_changed`;
    default:
      return `unknown`;
  }
};
const Ra = (e) => {
  let t = e.split(`\0`);
  let n = [];
  for (let e = 0; e < t.length; e += 1) {
    let r = t[e];
    if (!r) {
      continue;
    }
    let i = La(r);
    if (i === `renamed` || i === `copied`) {
      let r = t[e + 1] || null;
      let a = t[e + 2] || null;
      e += 2;
      n.push({
        path: r && a ? `${r} => ${a}` : a || r || ``,
        headPath: r,
        currentPath: a,
        status: i,
      });
      continue;
    }
    let a = t[e + 1] || ``;
    e += 1;
    n.push({
      path: a,
      headPath: i === `added` ? null : a,
      currentPath: i === `deleted` ? null : a,
      status: i,
    });
  }
  return n;
};
const za = (e, t) =>
  t.length === 0
    ? e.map((e) => ({
        ...e,
        status: `modified`,
      }))
    : t.map((t, n) => {
        let r = e[n];
        return {
          ...t,
          additions: r?.additions ?? 0,
          deletions: r?.deletions ?? 0,
        };
      });
const Ba = (e, t) => za(Ia(e), Ra(t));
const Va = (e, t) =>
  Ba(e, t).reduce(
    (e, t) => {
      e.additions += t.additions;
      e.deletions += t.deletions;
      e.changedFiles += 1;
      return e;
    },
    {
      additions: 0,
      deletions: 0,
      changedFiles: 0,
    },
  );
const Ha = async (e) => {
  try {
    return (
      (
        await Q(`git`, [`rev-parse`, `--is-inside-work-tree`], {
          nodeOptions: {
            cwd: e,
          },
          throwOnError: true,
        })
      ).stdout.trim() === `true`
    );
  } catch {
    return false;
  }
};
const Ua = async (e) => {
  let [t, n] = await Xa(e);
  return Va(t, n);
};
const Wa = async (e) => {
  let [t, n] = await Xa(e);
  return Ba(t, n);
};
const Ga = async (e, t, n, r) => {
  let i = await Ka(e, t, n, r);
  let a = (n || t).replace(/\\/g, `/`);
  let o = r || t;
  let [s, c] = await Promise.all([qa(e, a), Ja(e, o)]);
  return {
    originalContent: s,
    currentContent: c,
    patchContent: i,
  };
};
const Ka = async (e, t, n, r) => {
  let i = n && r && n !== r ? [n, r] : [r || t];
  try {
    return (
      await Q(`git`, [`diff`, `-M`, `HEAD`, `--`, ...i], {
        nodeOptions: {
          cwd: e,
        },
        throwOnError: true,
      })
    ).stdout;
  } catch {
    return ``;
  }
};
const qa = async (e, t) => {
  try {
    return (
      await Q(`git`, [`show`, `HEAD:${t}`], {
        nodeOptions: {
          cwd: e,
        },
        throwOnError: true,
      })
    ).stdout;
  } catch {
    return null;
  }
};
const Ja = async (e, t) => {
  try {
    return await M(v.join(e, t), `utf8`);
  } catch {
    return null;
  }
};
const Ya = async (e, t) => {
  try {
    return (
      await Q(`git`, t, {
        nodeOptions: {
          cwd: e,
        },
        throwOnError: true,
      })
    ).stdout;
  } catch {
    return ``;
  }
};
const Xa = async (e) =>
  Promise.all([
    Ya(e, [`diff`, `--numstat`, `-z`, `-M`, `HEAD`, `--`, `.`]),
    Ya(e, [`diff`, `--name-status`, `-z`, `-M`, `HEAD`, `--`, `.`]),
  ]);
const Za = [
  {
    icon: `i-vscode-icons-file-type-vscode`,
    label: `VS Code`,
    value: `vscode`,
    platforms: [`macos`, `linux`, `windows`],
  },
  {
    icon: `i-vscode-icons-file-type-vscode-insiders`,
    label: `VS Code Insiders`,
    value: `vscode-insiders`,
    platforms: [`macos`, `linux`, `windows`],
  },
  {
    icon: `i-simple-icons-zedindustries`,
    label: `Zed`,
    value: `zed`,
    platforms: [`macos`, `linux`, `windows`],
  },
  {
    icon: `i-devicon-zed`,
    label: `Zed Preview`,
    value: `zed-preview`,
    platforms: [`macos`, `linux`, `windows`],
  },
  {
    icon: `i-custom-ghostty`,
    label: `Ghostty`,
    value: `ghostty`,
    platforms: [`macos`, `linux`],
  },
  {
    icon: `i-custom-finder`,
    label: `Finder`,
    value: `finder`,
    platforms: [`macos`],
  },
  {
    icon: `i-twemoji-file-folder`,
    label: `File Explorer`,
    value: `file-explorer`,
    platforms: [`linux`, `windows`],
  },
  {
    icon: `i-logos-xcode`,
    label: `Xcode`,
    value: `xcode`,
    platforms: [`macos`],
  },
  {
    icon: `i-simple-icons-cursor`,
    label: `Cursor`,
    value: `cursor`,
    platforms: [`macos`, `windows`, `linux`],
  },
];
const Qa = (e) => e === `macos`;
const $a = (e) =>
  e === `macos` ? `macOS` : e === `linux` ? `Linux` : `Windows`;
const eo = (e) => {
  let t = e.map($a);
  if (t.length === 0) {
    return `Unsupported on the current platform.`;
  } else if (t.length === 1) {
    return `${t[0]} only.`;
  } else if (t.length === 2) {
    return `${t[0]} and ${t[1]} only.`;
  } else {
    return `Supported on ${t.slice(0, -1).join(`, `)}, and ${t.at(-1)}.`;
  }
};
const to = (e) => Za.find((t) => t.value === e);
Za.filter((e) => e.platforms.some(Qa));
const no = (e) => to(e)?.platforms.some(Qa) ?? false;
const ro = (e) => to(e)?.label ?? e;
const io = (e) => eo(to(e)?.platforms ?? []);
const ao = (e) => {
  let t = e.trim();
  if (!t) {
    throw Error(`Path is required.`);
  }
  let n = t.replace(/^~(?=$|[\\/])/, P.homedir());
  return L.resolve(n);
};
const oo = (e, t, n) => {
  let r = t instanceof Error ? t.message.trim() : String(t).trim();
  let i = r ? ` ${r}` : ``;
  let a = n ? ` ${n}` : ``;
  return Error(`Failed to open with ${e}.${i}${a}`);
};
async function so(e, t, n, r) {
  try {
    let { exitCode: n, stderr: i } = await Q(e, t, {
      throwOnError: false,
      nodeOptions: {
        env: r,
      },
    });
    if (n === 0) {
      return;
    }
    throw Error(i.trim() || `${e} exited with code ${n}`);
  } catch (e) {
    throw oo(n, e);
  }
}
async function co(e, t, n, r) {
  await so(`open`, [`-a`, e, t], n, r);
}
async function lo(e) {
  if (F.statSync(e).isDirectory()) {
    await g.openPath(e);
    return;
  }
  g.showItemInFolder(e);
}
async function uo(e, t, n, r) {
  let i;
  for (let r of n) {
    try {
      await so(r.command, r.args, e, t);
      return;
    } catch (e) {
      i = e;
    }
  }
  throw i instanceof Error
    ? Error(`${i.message}${r ? ` ${r}` : ``}`)
    : oo(e, i ?? Error(`No available launcher command.`), r);
}
async function fo(e, t) {
  let n = ao(t);
  if (!F.existsSync(n)) {
    throw Error(`Path does not exist: ${n}`);
  }
  if (!no(e)) {
    throw Error(`${ro(e)} is not supported on this platform. ${io(e)}`);
  }
  let r = {
    ...process.env,
    ...(await Zr()),
  };
  switch (e) {
    case `vscode`:
      await uo(`VS Code`, r, [
        {
          command: `code`,
          args: [n],
        },
      ]);
      return;
    case `vscode-insiders`:
      await uo(`VS Code Insiders`, r, [
        {
          command: `code-insiders`,
          args: [n],
        },
      ]);
      return;
    case `cursor`:
      await uo(`Cursor`, r, [
        {
          command: `cursor`,
          args: [n],
        },
      ]);
      return;
    case `zed`:
      await uo(
        `Zed`,
        r,
        [
          {
            command: `zed`,
            args: [n],
          },
        ],
        `Make sure the Zed CLI is installed and available on PATH.`,
      );
      return;
    case `zed-preview`:
      await uo(
        `Zed Preview`,
        r,
        [
          {
            command: `zed-preview`,
            args: [n],
          },
        ],
        `Make sure the Zed Preview CLI is installed and available on PATH.`,
      );
      return;
    case `ghostty`:
      await so(
        `open`,
        [
          `-na`,
          `Ghostty`,
          `--args`,
          `--working-directory=${F.statSync(n).isDirectory() ? n : L.dirname(n)}`,
        ],
        `Ghostty`,
        r,
      );
      return;
    case `finder`:
      await lo(n);
      return;
    case `file-explorer`:
      await lo(n);
      return;
    case `xcode`:
      await co(`Xcode`, n, `Xcode`, r);
      return;
  }
}
const po = (e) => e.filter(Boolean);
const mo = (e) => (e instanceof n ? e : undefined);
const ho = () => {
  let e = process.platform === `darwin`;
  let t = c.getName();
  let i = async (e) => {
    let r = await _n();
    let i = r.platform === `macos` ? `macOS` : r.platform;
    let a = [
      `Version: ${c.getVersion()}`,
      `Release date: 2026/04/26`,
      `Electron: ${process.versions.electron}`,
      `Chromium: ${process.versions.chrome}`,
      `Node.js: ${process.versions.node}`,
      `V8: ${process.versions.v8}`,
      `OS: ${i} ${r.version}`,
    ].join(`
`);
    let o = `${t}\n${a}`;
    let s = {
      type: `info`,
      title: `About ${t}`,
      message: t,
      detail: a,
      buttons: [`OK`, `Copy`],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
    };
    let d = e ?? n.getFocusedWindow() ?? undefined;
    if (d) {
      let { response: e } = await u.showMessageBox(d, s);
      if (e === 1) {
        l.writeText(o);
      }
      return;
    }
    let { response: f } = await u.showMessageBox(s);
    if (f === 1) {
      l.writeText(o);
    }
  };
  let a = [
    ...(e
      ? [
          {
            label: t,
            submenu: [
              {
                label: `About ${t}`,
                click: (e, t) => {
                  i(mo(t));
                },
              },
              {
                type: `separator`,
              },
              {
                label: `Settings`,
                accelerator: `CmdOrCtrl+,`,
                click: () => {
                  cr();
                },
              },
              {
                type: `separator`,
              },
              {
                role: `services`,
              },
              {
                type: `separator`,
              },
              {
                role: `hide`,
              },
              {
                role: `hideOthers`,
              },
              {
                role: `unhide`,
              },
              {
                type: `separator`,
              },
              {
                role: `quit`,
              },
            ],
          },
        ]
      : []),
    {
      label: `File`,
      submenu: [
        {
          label: `New Chat`,
          accelerator: `CmdOrCtrl+N`,
          click(e, t) {
            let n = mo(t);
            if (n) {
              Z(n.webContents).newChat.send();
            }
          },
        },
        {
          type: `separator`,
        },
        e
          ? {
              label: `Close`,
              accelerator: `CmdOrCtrl+W`,
              click(e, t) {
                let n = mo(t);
                if (n) {
                  if (n.closable) {
                    n.close();
                  } else {
                    n.hide();
                  }
                }
              },
            }
          : {
              role: `quit`,
            },
      ],
    },
    {
      label: `Edit`,
      submenu: [
        {
          role: `undo`,
        },
        {
          role: `redo`,
        },
        {
          type: `separator`,
        },
        {
          role: `cut`,
        },
        {
          role: `copy`,
        },
        {
          role: `paste`,
        },
        ...(e
          ? [
              {
                role: `pasteAndMatchStyle`,
              },
              {
                role: `delete`,
              },
              {
                role: `selectAll`,
              },
              {
                type: `separator`,
              },
              {
                label: `Speech`,
                submenu: [
                  {
                    role: `startSpeaking`,
                  },
                  {
                    role: `stopSpeaking`,
                  },
                ],
              },
            ]
          : [
              {
                role: `delete`,
              },
              {
                type: `separator`,
              },
              {
                role: `selectAll`,
              },
            ]),
      ],
    },
    {
      label: `View`,
      submenu: po([
        {
          label: `Back`,
          accelerator: `CmdOrCtrl+[`,
          click(e, t) {
            let n = mo(t);
            if (n && n.webContents.navigationHistory.canGoBack()) {
              n.webContents.navigationHistory.goBack();
            }
          },
        },
        {
          label: `Forward`,
          accelerator: `CmdOrCtrl+]`,
          click(e, t) {
            let n = mo(t);
            if (n && n.webContents.navigationHistory.canGoForward()) {
              n.webContents.navigationHistory.goForward();
            }
          },
        },
        {
          type: `separator`,
        },
        {
          label: `Command Center`,
          accelerator: `CmdOrCtrl+P`,
          click(e, t) {
            let n = mo(t);
            if (n) {
              Z(n.webContents).toggleCommandCenter.send();
            }
          },
        },
        {
          label: `Toggle Model Dropdown`,
          accelerator: `CmdOrCtrl+/`,
          click(e, t) {
            let n = mo(t);
            if (n) {
              Z(n.webContents).toggleModelDropdown.send();
            }
          },
        },
        {
          label: `Search`,
          accelerator: `CmdOrCtrl+Shift+F`,
          click(e, t) {
            let n = mo(t);
            if (n) {
              Z(n.webContents).searchChats.send();
            }
          },
        },
        {
          label: `Toggle Sidebar`,
          accelerator: `CmdOrCtrl+B`,
          click(e, t) {
            let n = mo(t);
            if (n) {
              Z(n.webContents).toggleSidebar.send();
            }
          },
        },
        {
          label: `Toggle Right Sidebar`,
          accelerator: `CmdOrCtrl+Shift+B`,
          click(e, t) {
            let n = mo(t);
            if (n) {
              Z(n.webContents).toggleRightbar.send();
            }
          },
        },
        {
          type: `separator`,
        },
        {
          label: `Abort Generation`,
          accelerator: `Ctrl+C`,
          click(e, t) {
            let n = mo(t);
            if (n) {
              Z(n.webContents).abortGeneration.send();
            }
          },
        },
        false,
        false,
        false,
        false,
        {
          type: `separator`,
        },
        ...Array.from(
          {
            length: 9,
          },
          (e, t) => {
            let n = t + 1;
            return {
              label: `Assistant ${n}`,
              accelerator: `CmdOrCtrl+${n}`,
              click(e, t) {
                let r = mo(t);
                if (r) {
                  Z(r.webContents).selectAssistant.send(n);
                }
              },
            };
          },
        ),
      ]),
    },
    {
      label: `Window`,
      submenu: [
        {
          role: `minimize`,
        },
        {
          role: `zoom`,
        },
        {
          type: `separator`,
        },
        {
          label: `Next Chat`,
          accelerator: `Ctrl+Tab`,
          click(e, t) {
            let n = mo(t);
            if (n) {
              Z(n.webContents).nextChat.send();
            }
          },
        },
        {
          label: `Previous Chat`,
          accelerator: `Ctrl+Shift+Tab`,
          click(e, t) {
            let n = mo(t);
            if (n) {
              Z(n.webContents).previousChat.send();
            }
          },
        },
        ...(e
          ? [
              {
                type: `separator`,
              },
              {
                role: `front`,
              },
              {
                type: `separator`,
              },
              {
                role: `window`,
              },
            ]
          : [
              {
                role: `close`,
              },
            ]),
      ],
    },
    {
      role: `help`,
      submenu: po([
        {
          label: `Documentation`,
          click() {
            g.openExternal(`https://docs.chatwise.app`);
          },
        },
        {
          label: `Send Feedback`,
          click() {
            g.openExternal(
              `https://github.com/egoist/chatwise-releases/issues`,
            );
          },
        },
      ]),
    },
  ];
  return r.buildFromTemplate(a);
};
const $ = _e.create();
async function go(e) {
  return B(Sn, `${e}.json`);
}
async function _o(e) {
  try {
    return (
      (
        await Q(`git`, [`branch`, `--show-current`], {
          nodeOptions: {
            cwd: e,
          },
          throwOnError: true,
        })
      ).stdout.trim() || null
    );
  } catch {
    return null;
  }
}
const vo = {
  showSettingsWindow: $.procedure.input().action(async ({ input: e }) => {
    cr(e.url);
  }),
  showCurrentWindow: $.procedure
    .input()
    .action(async ({ context: e, input: t }) => {
      let r = n.fromWebContents(e.sender);
      r?.show();
      if (t.focus) {
        r?.focus();
      }
    }),
  focusCurrentWindow: $.procedure.action(async ({ context: e }) => {
    n.fromWebContents(e.sender)?.focus();
  }),
  getDir: $.procedure
    .input()
    .action(async ({ input: e }) =>
      e.type === `app-data`
        ? bn
        : e.type === `home`
          ? P.homedir()
          : e.type === `temp`
            ? P.tmpdir()
            : e.type === `logs`
              ? xn
              : e.type === `bin`
                ? En
                : ``,
    ),
  getShellEnv: $.procedure.action(async () => Zr()),
  isBinDownloaded: $.procedure
    .input()
    .action(async ({ input: e }) => di(e.name)),
  downloadBin: $.procedure.input().action(async ({ input: e }) => {
    await pi(e.name);
  }),
  ensureBinVersion: $.procedure
    .input()
    .action(async ({ input: e }) => mi(e.name, e.env)),
  bunInstallInTempFolder: $.procedure
    .input()
    .action(async ({ input: e }) => vi(e.folderName, e.files, e.env)),
  showContextMenu: $.procedure
    .input()
    .action(async ({ input: e, context: t }) => {
      let i = t.sender;
      let a = n.fromWebContents(i);
      if (!a) {
        return;
      }
      let o = (e) =>
        e.type === `separator`
          ? {
              type: `separator`,
            }
          : e.type === `copy` || e.type === `paste` || e.type === `cut`
            ? {
                role: e.type,
              }
            : {
                label: e.text,
                enabled: e.enabled ?? true,
                click: () => {
                  a.webContents.send(`$context-menu-click`, {
                    id: e.id,
                  });
                },
                submenu: e.items ? e.items.map((e) => o(e)) : undefined,
                type:
                  typeof e.checked == `boolean`
                    ? `checkbox`
                    : e.items
                      ? `submenu`
                      : `normal`,
                checked: e.checked,
              };
      r.buildFromTemplate([
        ...e.items.map((e) => o(e)),
        ...(process.env.CHATWISE_DEV_MENU
          ? [
              {
                type: `separator`,
              },
              {
                label: `Refresh`,
                click: () => {
                  a.webContents.reload();
                },
              },
              {
                label: `Inspect Element`,
                click: () => {
                  a.webContents.inspectElement(e.x, e.y);
                },
              },
            ]
          : []),
      ]).popup({
        x: e.x,
        y: e.y,
        callback: () => {
          i.send(`$context-menu-close`);
        },
      });
    }),
  showAppMenu: $.procedure.input().action(async ({ input: e, context: t }) => {
    let r = n.fromWebContents(t.sender);
    if (r) {
      ho().popup({
        window: r,
        x: e.x,
        y: e.y,
      });
    }
  }),
  appCacheGet: $.procedure.input().action(async ({ input: e }) => {
    let t = await go(e.key);
    if (F.existsSync(t)) {
      return await M(t, `utf8`);
    } else {
      return null;
    }
  }),
  appCacheSet: $.procedure.input().action(async ({ input: e }) => {
    let t = await go(e.key);
    await F.promises.mkdir(v.dirname(t), {
      recursive: true,
    });
    await F.promises.writeFile(t, e.value, `utf8`);
  }),
  osInfo: $.procedure.action(async () => await _n()),
  dbGet: $.procedure.input().action(async ({ input: e }) => {
    let { ensureDB: t } = await import(`./db-Bq4zIyHJ.js`);
    let n = (await t()).prepare(e.sql);
    if (!n.reader) {
      throw Error(`dbGet requires a read query`);
    }
    return n.get(...(e.params ?? []));
  }),
  dbAll: $.procedure.input().action(async ({ input: e }) => {
    let { ensureDB: t } = await import(`./db-Bq4zIyHJ.js`);
    let n = (await t()).prepare(e.sql);
    if (!n.reader) {
      throw Error(`dbAll requires a read query`);
    }
    return n.all(...(e.params ?? []));
  }),
  dbExecute: $.procedure.input().action(async ({ input: e }) => {
    let { ensureDB: t } = await import(`./db-Bq4zIyHJ.js`);
    let n = (await t()).prepare(e.sql);
    if (n.reader) {
      throw Error(`dbExecute requires a write query`);
    }
    let r = n.run(...(e.params ?? []));
    return {
      rowsAffected: r.changes,
      lastInsertRowid: r.lastInsertRowid,
    };
  }),
  readTextFile: $.procedure
    .input()
    .action(async ({ input: e }) => await M(e.path, `utf8`)),
  grep: $.procedure.input().action(async ({ input: e }) => {
    let { runGrepTool: t } = await import(`./grep-CL7ZkgWP.js`);
    return t(e);
  }),
  globTool: $.procedure.input().action(async ({ input: e }) => {
    let { runGlobTool: t } = await import(`./glob-tool-BsM9YotD.js`);
    return t(e);
  }),
  readFileAsBase64: $.procedure
    .input()
    .action(async ({ input: e }) => await M(e.path, `base64`)),
  readFileBinary: $.procedure.input().action(async ({ input: e }) => {
    let t = await M(e.path);
    return Uint8Array.from(t);
  }),
  readDir: $.procedure
    .input()
    .action(async ({ input: e }) => F.promises.readdir(e.path)),
  glob: $.procedure.input().action(async ({ input: e }) =>
    Pa(e.path, {
      pattern: e.pattern,
      limit: e.limit,
    }),
  ),
  resolveInAppDataDir: $.procedure
    .input()
    .action(async ({ input: e }) =>
      !e.args || e.args.length === 0 ? bn : v.join(bn, ...e.args),
    ),
  saveRecordingAsWav: $.procedure
    .input()
    .action(async ({ input: e }) => ei(e.filename, e.buffer)),
  pathExists: $.procedure
    .input()
    .action(async ({ input: e }) => F.existsSync(e.path)),
  ensureDir: $.procedure.input().action(async ({ input: e }) => {
    await F.promises.mkdir(e.path, {
      recursive: true,
    });
  }),
  writeFile: $.procedure.input().action(async ({ input: e }) => {
    await F.promises.mkdir(v.dirname(e.path), {
      recursive: true,
    });
    await N(e.path, Buffer.from(e.content));
  }),
  writeTextFile: $.procedure.input().action(async ({ input: e }) => {
    await F.promises.mkdir(v.dirname(e.path), {
      recursive: true,
    });
    await N(e.path, e.content, `utf8`);
  }),
  removePath: $.procedure.input().action(async ({ input: e }) => {
    await F.promises.rm(e.path, {
      recursive: true,
      force: true,
    });
  }),
  pathStats: $.procedure.input().action(async ({ input: e }) => {
    let t = await F.promises.stat(e.path);
    return {
      isDir: t.isDirectory(),
      size: t.size,
    };
  }),
  createDir: $.procedure.input().action(async ({ input: e }) => {
    await F.promises.mkdir(e.path, {
      recursive: true,
    });
  }),
  copyFile: $.procedure.input().action(async ({ input: e }) => {
    await F.promises.mkdir(v.dirname(e.dest), {
      recursive: true,
    });
    await F.promises.copyFile(e.src, e.dest);
  }),
  cmdCompressImage: $.procedure.input().action(async ({ input: e }) => {
    await ci(e.inputPath, e.outputPath);
  }),
  openPath: $.procedure.input().action(async ({ input: e }) => {
    await g.openPath(e.path);
  }),
  openExternalUrl: $.procedure.input().action(async ({ input: e }) => {
    await g.openExternal(e.url);
  }),
  startOauthServer: $.procedure.action(async () => {
    await Oi();
  }),
  stopOauthServer: $.procedure.action(async () => {
    await ki();
  }),
  createInAppBrowserSession: $.procedure
    .input()
    .action(async ({ input: e }) => {
      await sa(e);
    }),
  openInAppBrowserWindow: $.procedure.input().action(async ({ input: e }) => {
    await ca(e.url);
  }),
  getInAppBrowserState: $.procedure.action(async ({ context: e }) => {
    let t = n.fromWebContents(e.sender);
    if (!t) {
      throw Error(`in-app browser window was not found`);
    }
    return la(t);
  }),
  navigateInAppBrowser: $.procedure
    .input()
    .action(async ({ context: e, input: t }) => {
      let r = n.fromWebContents(e.sender);
      if (!r) {
        throw Error(`in-app browser window was not found`);
      }
      await ua(r, t.url);
    }),
  goBackInAppBrowser: $.procedure.action(async ({ context: e }) => {
    let t = n.fromWebContents(e.sender);
    if (!t) {
      throw Error(`in-app browser window was not found`);
    }
    da(t);
  }),
  goForwardInAppBrowser: $.procedure.action(async ({ context: e }) => {
    let t = n.fromWebContents(e.sender);
    if (!t) {
      throw Error(`in-app browser window was not found`);
    }
    fa(t);
  }),
  reloadInAppBrowser: $.procedure.action(async ({ context: e }) => {
    let t = n.fromWebContents(e.sender);
    if (!t) {
      throw Error(`in-app browser window was not found`);
    }
    pa(t);
  }),
  scrapeInAppBrowser: $.procedure.input().action(async ({ input: e }) => oa(e)),
  closeInAppBrowserSession: $.procedure.input().action(async ({ input: e }) => {
    await ia(e.id);
  }),
  renderHtmlToPdf: $.procedure.input().action(async ({ input: e }) => {
    await ha(e.html, e.outputPath);
  }),
  showInFolder: $.procedure.input().action(async ({ input: e }) => {
    g.showItemInFolder(e.path);
  }),
  copyImageToClipboard: $.procedure.input().action(async ({ input: e }) => {
    let t = f.createFromBuffer(Buffer.from(e.data));
    l.writeImage(t);
  }),
  copyTextToClipboard: $.procedure.input().action(async ({ input: e }) => {
    l.writeText(e.data);
  }),
  getClipboardText: $.procedure.action(async () => l.readText()),
  showConfirmDialog: $.procedure
    .input()
    .action(async ({ input: e, context: t }) => {
      let r = n.fromWebContents(t.sender);
      if (r) {
        return (
          (
            await u.showMessageBox(r, {
              detail: e.message,
              message: e.title,
              buttons: [`Cancel`, `Yes`],
              defaultId: 1,
              type: e.type,
            })
          ).response === 1
        );
      }
    }),
  showOpenDialog: $.procedure
    .input()
    .action(async ({ context: e, input: t }) => {
      let r = n.fromWebContents(e.sender);
      if (!r) {
        return [];
      }
      let i = [];
      if (t.dirOnly) {
        i.push(`openDirectory`, `createDirectory`);
      } else {
        i.push(`openFile`);
      }
      if (t.multiple) {
        i.push(`multiSelections`);
      }
      return (
        await u.showOpenDialog(r, {
          message: t.title,
          properties: i,
          defaultPath: t.defaultPath,
        })
      ).filePaths;
    }),
  showSaveDialog: $.procedure
    .input()
    .action(async ({ context: e, input: t }) => {
      let r = n.fromWebContents(e.sender);
      if (!r) {
        return null;
      }
      let i = await u.showSaveDialog(r, {
        title: t.title,
        defaultPath: t.defaultPath,
        filters: t.filters,
      });
      if (i.canceled) {
        return null;
      } else {
        return i.filePath;
      }
    }),
  showMessageDialog: $.procedure
    .input()
    .action(async ({ input: e, context: t }) => {
      let r = n.fromWebContents(t.sender);
      if (r) {
        await u.showMessageBox(r, {
          message: e.title,
          detail: e.message,
          type: e.type,
        });
      }
    }),
  zipFolder: $.procedure.input().action(async ({ input: e }) => {
    await ti(e.folder, e.outputPath);
  }),
  unzipFile: $.procedure.input().action(async ({ input: e }) => {
    await ni(e.zipPath, e.outputDir);
  }),
  setLoggerEnabled: $.procedure
    .input()
    .action(async ({ input: e, context: t }) => {
      n.getAllWindows().forEach((n) => {
        if (n.webContents !== t.sender) {
          Z(n.webContents).setLoggerEnabled.send(e.enabled);
        }
      });
    }),
  setTrackingEnabled: $.procedure
    .input()
    .action(async ({ input: e, context: t }) => {
      n.getAllWindows().forEach((n) => {
        if (n.webContents !== t.sender) {
          Z(n.webContents).setTrackingEnabled.send(e.enabled);
        }
      });
    }),
  changeLanguage: $.procedure.input().action(async ({ input: e }) => {
    n.getAllWindows().forEach((t) => {
      Z(t.webContents).changeLanguage.send(e.language);
    });
  }),
  refreshAccentColor: $.procedure.action(async () => {
    n.getAllWindows().forEach((e) => {
      Z(e.webContents).refreshAccentColor.send();
    });
  }),
  initFonts: $.procedure.action(async () => {
    n.getAllWindows().forEach((e) => {
      Z(e.webContents).initFonts.send();
    });
  }),
  invalidateQueryClient: $.procedure.action(async () => {
    n.getAllWindows().forEach((e) => {
      Z(e.webContents).invalidateQueryClient.send();
    });
  }),
  getFonts: $.procedure.action(async () =>
    (await U()).map((e) => e.replace(/"/g, ``)),
  ),
  applyTheme: $.procedure.input().action(async ({ input: e }) => {
    n.getAllWindows().forEach((t) => {
      Z(t.webContents).applyTheme.send(e.theme);
    });
  }),
  saveTheme: $.procedure.input().action(async ({ input: e }) => {
    p.themeSource = e.theme;
    Fn({
      theme: e.theme,
    });
    n.getAllWindows().forEach((t) => {
      Z(t.webContents).applyTheme.send(e.theme);
    });
  }),
  saveLocalSettings: $.procedure.input().action(async ({ input: e }) => {
    await Fn(e.settings);
    if (`proxy_url` in e.settings || `proxy_bypass_rules` in e.settings) {
      await In();
    }
  }),
  discoverSkill: $.procedure.input().action(async ({ input: e }) => {
    let t = P.homedir();
    let n = [
      v.join(t, `.claude`, `skills`),
      v.join(t, `.agents`, `skills`),
      e.workDir ? v.join(e.workDir, `.claude`, `skills`) : null,
      e.workDir ? v.join(e.workDir, `.agents`, `skills`) : null,
    ].filter((e) => e != null);
    let r = await Promise.all(
      n.map(async (e) =>
        (
          await gn(`*/SKILL.md`, {
            cwd: e,
          })
        ).map((t) => ({
          relativePath: t,
          fullPath: v.join(e, t),
        })),
      ),
    );
    let i = new Map();
    for (let e of r) {
      for (let t of e) {
        i.set(t.relativePath, t);
      }
    }
    return await Promise.all(
      [...i.values()].map(async (e) => {
        let t = await F.promises.readFile(e.fullPath, `utf8`).catch(() => null);
        if (!t) {
          return null;
        }
        let { name: n, description: r } = await ri(t);
        if (r) {
          return {
            name: n || v.dirname(e.relativePath),
            description: r,
            path: e.fullPath,
            content: t,
          };
        } else {
          return null;
        }
      }),
    ).then((e) => e.filter((e) => e != null));
  }),
  sendNotification: $.procedure
    .input()
    .action(async ({ input: e, context: t }) => {
      if (!e.whenNotFocused || !t.sender.isFocused()) {
        new a({
          title: e.title,
          body: e.body,
        }).show();
      }
    }),
  updateMCPInstance: $.procedure
    .input()
    .action(async ({ input: e, context: t }) => {
      Z(t.sender).updateMCPInstance.send(e.id, e.instance);
    }),
  setAlwaysOnTop: $.procedure
    .input()
    .action(async ({ input: e, context: t }) => {
      n.fromWebContents(t.sender)?.setAlwaysOnTop(e.value);
    }),
  getWindowProp: $.procedure
    .input()
    .action(async ({ context: e, input: t }) => {
      let r = n.fromWebContents(e.sender);
      if (r) {
        if (t.type === `is-minimized`) {
          return r.isMinimized();
        } else {
          return r.isMaximized();
        }
      } else {
        return false;
      }
    }),
  setWindowProp: $.procedure
    .input()
    .action(async ({ input: e, context: t }) => {
      let r = n.fromWebContents(t.sender);
      if (r) {
        if (e.type === `minimize`) {
          r.minimize();
        } else if (e.type === `maximize`) {
          r.maximize();
        } else {
          r.unmaximize();
        }
      }
    }),
  closeWindow: $.procedure.action(async ({ context: e }) => {
    let t = n.fromWebContents(e.sender);
    if (t) {
      t.close();
    }
  }),
  appendToLogsFolder: $.procedure.input().action(async ({ input: e }) => {
    if (
      e.filename.includes(`/`) ||
      e.filename.includes(`\\`) ||
      e.filename.includes(`..`)
    ) {
      console.log(
        `appendToLogsFolder: rejected suspicious filename: ${e.filename}`,
      );
      return;
    }
    let t = xn;
    await F.promises.mkdir(t, {
      recursive: true,
    });
    let n = B(t, e.filename);
    await F.promises.appendFile(n, e.data, `utf8`);
  }),
  removeLogFile: $.procedure.input().action(async ({ input: e }) => {
    let t = B(xn, e.filename);
    await F.promises.unlink(t);
  }),
  logFileSize: $.procedure.input().action(async ({ input: e }) => {
    let t = B(xn, e.filename);
    return (await F.promises.stat(t)).size;
  }),
  playSound: $.procedure
    .input()
    .action(
      async ({ input: e }) =>
        `data:audio/ogg;base64,${(await M(B(Tn, `${e.name}.ogg`))).toString(`base64`)}`,
    ),
  checkForUpdates: $.procedure.action(
    async () => await (await import(`./updater-OQv-S5-z.js`)).checkForUpdates(),
  ),
  downloadUpdate: $.procedure.action(async () => {
    await (await import(`./updater-OQv-S5-z.js`)).downloadUpdate();
  }),
  installUpdate: $.procedure.action(async () => {
    (await import(`./updater-OQv-S5-z.js`)).installUpdate();
  }),
  isLaunched: $.procedure.action(async () =>
    globalThis.__is_launched__
      ? false
      : ((globalThis.__is_launched__ = true), true),
  ),
  getGitDefaultBranch: $.procedure
    .input()
    .action(async ({ input: e }) => _o(e.workDir)),
  getGitBranches: $.procedure.input().action(async ({ input: e }) => {
    try {
      let t = (
        await Q(
          `git`,
          [`branch`, `-a`, `--format=%(refname)|%(refname:short)`],
          {
            nodeOptions: {
              cwd: e.workDir,
            },
            throwOnError: true,
          },
        )
      ).stdout
        .split(
          `
`,
        )
        .map((e) => e.trim())
        .filter(Boolean)
        .map((e) => {
          let [t, n] = e.split(`|`);
          if (t.startsWith(`refs/remotes/`)) {
            return {
              name: n,
              isRemote: true,
            };
          } else {
            return {
              name: n,
            };
          }
        });
      if (t.length > 0) {
        return t;
      }
    } catch {}
    let t = await _o(e.workDir);
    if (t) {
      return [
        {
          name: t,
        },
      ];
    } else {
      return [];
    }
  }),
  initGitRepository: $.procedure.input().action(async ({ input: e }) => {
    await Q(`git`, [`init`], {
      nodeOptions: {
        cwd: e.workDir,
      },
      throwOnError: true,
    });
  }),
  getGitDiffStat: $.procedure.input().action(async ({ input: e }) =>
    (await Ha(e.workDir))
      ? {
          isGitRepo: true,
          ...(await Ua(e.workDir)),
        }
      : {
          isGitRepo: false,
          additions: 0,
          deletions: 0,
          changedFiles: 0,
        },
  ),
  getGitDiffFiles: $.procedure.input().action(async ({ input: e }) =>
    (await Ha(e.workDir))
      ? {
          isGitRepo: true,
          files: await Wa(e.workDir),
        }
      : {
          isGitRepo: false,
          files: [],
        },
  ),
  getGitDiffFileContent: $.procedure.input().action(async ({ input: e }) =>
    (await Ha(e.workDir))
      ? {
          isGitRepo: true,
          ...(await Ga(e.workDir, e.filePath, e.headPath, e.currentPath)),
        }
      : {
          isGitRepo: false,
          originalContent: null,
          currentContent: null,
          patchContent: ``,
        },
  ),
  switchGitBranch: $.procedure.input().action(async ({ input: e }) => {
    let { stderr: t, exitCode: n } = await Q(`git`, [`checkout`, e.branch], {
      nodeOptions: {
        cwd: e.workDir,
      },
    });
    if (n !== 0) {
      throw Error(t);
    }
  }),
  canGoBack: $.procedure.action(async ({ context: e }) => {
    let t = n.fromWebContents(e.sender);
    if (t) {
      return t.webContents.navigationHistory.canGoBack();
    } else {
      return false;
    }
  }),
  canGoForward: $.procedure.action(async ({ context: e }) => {
    let t = n.fromWebContents(e.sender);
    if (t) {
      return t.webContents.navigationHistory.canGoForward();
    } else {
      return false;
    }
  }),
  goBack: $.procedure.action(async ({ context: e }) => {
    let t = n.fromWebContents(e.sender);
    if (t && t.webContents.navigationHistory.canGoBack()) {
      t.webContents.navigationHistory.goBack();
    }
  }),
  goForward: $.procedure.action(async ({ context: e }) => {
    let t = n.fromWebContents(e.sender);
    if (t && t.webContents.navigationHistory.canGoForward()) {
      t.webContents.navigationHistory.goForward();
    }
  }),
  openPathWithProgram: $.procedure.input().action(async ({ input: e }) => {
    await fo(e.program, e.path);
  }),
};
const yo = [];
let bo = false;
const xo = (e) => {
  if (bo) {
    throw Error(
      `electron-serve: A new scheme cannot be registered after app is ready. Make sure to call serve() before app.whenReady().`,
    );
  }
  yo.push(e);
  if (yo.length === 1) {
    queueMicrotask(() => {
      bo = true;
      t.protocol.registerSchemesAsPrivileged(yo);
    });
  }
};
const So = async (e, t) => {
  try {
    if (!L.basename(e).includes(`.`) && !e.endsWith(`/`)) {
      let t = `${e}.html`;
      if (I(t)) {
        return t;
      }
    }
    let n = await O.stat(e);
    if (n.isFile()) {
      return e;
    }
    if (n.isDirectory()) {
      return So(L.join(e, `${t}.html`));
    }
  } catch {}
};
function Co(e = {}) {
  let n = {
    isCorsEnabled: true,
    scheme: `client`,
    hostname: `app`,
    file: `index`,
    directory: `.`,
    ...e,
  };
  n.directory = L.resolve(t.app.getAppPath(), n.directory);
  let r = async (e) => {
    if (n.middleware) {
      let t = await n.middleware(e);
      if (t) {
        return t;
      }
    }
    let r = new URL(e.url);
    if (r.hostname !== n.hostname) {
      return new Response(`hostname mismatches`, {
        status: 404,
        statusText: `Not Found`,
      });
    }
    let i = L.join(n.directory, `${n.file}.html`);
    let a = L.join(n.directory, decodeURIComponent(r.pathname));
    let o = L.relative(n.directory, a);
    if (!!o.startsWith(`..`) || !!L.isAbsolute(o)) {
      return new Response(`unsafe`, {
        status: 404,
        statusText: `Not Found`,
      });
    }
    let s = await So(a, n.file);
    let c = L.extname(a);
    if (!s && c && c !== `.html` && c !== `.asar`) {
      return new Response(`not found`, {
        status: 404,
        statusText: `Not Found`,
      });
    }
    let l = oe(s || i);
    let u = await t.net.fetch(l.toString());
    if ((s || i).endsWith(`.map`)) {
      let e = await u.arrayBuffer();
      return new Response(e, {
        status: u.status,
        statusText: u.statusText,
        headers: {
          ...Object.fromEntries(u.headers.entries()),
          "content-type": `application/json`,
        },
      });
    }
    return u;
  };
  xo({
    scheme: n.scheme,
    privileges: {
      standard: true,
      secure: true,
      allowServiceWorkers: true,
      supportFetchAPI: true,
      corsEnabled: n.isCorsEnabled,
      stream: true,
      codeCache: true,
    },
  });
  t.app.on(`ready`, () => {
    (n.partition
      ? t.session.fromPartition(n.partition)
      : t.session.defaultSession
    ).protocol.handle(n.scheme, r);
  });
}
const wo = `electron-fetch:`;
const To = (e) => `${wo}abort:${e}`;
function Eo() {
  d.addListener(`${wo}request`, async (e, t) => {
    let r = n.fromWebContents(e.sender);
    if (!r) {
      return;
    }
    let { port1: a, port2: o } = new i();
    r.webContents.postMessage(`${wo}${t.id}`, null, [o]);
    let s = To(t.id);
    let c = new AbortController();
    let l = false;
    let u;
    d.once(s, () => {
      if (!l) {
        l = true;
        c.abort();
      }
    });
    try {
      let { body: e, ...n } = t.init || {};
      let r = await m.fetch(t.url, {
        ...n,
        body: e,
        signal: c.signal,
      });
      a.postMessage({
        type: `response`,
        status: r.status,
        statusText: r.statusText,
        headers: [...r.headers.entries()],
      });
      u = r.body?.getReader();
      if (u) {
        while (true) {
          let { done: e, value: t } = await u.read();
          if (t) {
            a.postMessage({
              type: `chunk`,
              value: t,
            });
          }
          if (e) {
            break;
          }
        }
      }
    } catch (e) {
      if (
        e instanceof Error &&
        (e.name === `AbortError` || e.code === `ABORT_ERR`)
      ) {
        a.postMessage({
          type: `error`,
          error: `__aborted__`,
        });
      } else {
        a.postMessage({
          type: `error`,
          error: e,
        });
      }
    } finally {
      d.removeAllListeners(s);
      a.postMessage({
        type: `end`,
      });
      a.close();
      o.close();
    }
  });
}
r.setApplicationMenu(null);
const Do = `chatwise`;
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    c.setAsDefaultProtocolClient(Do, process.execPath, [
      v.resolve(process.argv[1]),
    ]);
  }
} else {
  c.setAsDefaultProtocolClient(Do);
}
Co({
  directory: wn,
  middleware: async (e) => {
    let t = new URL(e.url);
    if (t.hostname === `app-files`) {
      let e = t.searchParams.get(`path`);
      if (!e) {
        return;
      }
      let n = K(v.join(bn, `files`, e));
      return m.fetch(n.toString());
    }
    if (t.hostname === `file`) {
      let e = t.searchParams.get(`path`);
      if (!e) {
        return;
      }
      let n = K(e);
      return m.fetch(n.toString());
    }
  },
});
if (c.requestSingleInstanceLock()) {
  c.on(`second-instance`, (e, t, n) => {
    let r = t.pop();
    if (r) {
      ko(r);
    }
  });
  c.on(`open-url`, (e, t) => {
    ko(t);
  });
  c.whenReady().then(() => {
    c.on(`browser-window-created`, (e, t) => {});
    ve(vo);
    Pe();
    Eo();
    d.handle(`getAccentColor`, () => _.getAccentColor());
    d.handle(`getLocalSettings`, () => Pn());
    d.on(`setWindowBackground`, (e, t) => {
      n.fromWebContents(e.sender)?.setBackgroundColor(t);
    });
    d.on(`windowReady`, () => {});
    sr();
    p.themeSource = Pn().theme || `system`;
    In();
    import(`./tray-Bv309oC8.js`).then((e) => e.setupTray());
    import(`./updater-OQv-S5-z.js`).then((e) => e.setupAutoUpdater());
    import(`./menu-C5Duu9Ce.js`).then((e) =>
      r.setApplicationMenu(e.createAppMenu()),
    );
    c.on(`activate`, function () {
      ur();
    });
  });
  c.on(`before-quit`, () => {
    ir.value = true;
    Kn().then((e) => e.close());
  });
} else {
  c.quit();
}
function Oo(e) {
  try {
    return new URL(e);
  } catch {
    return null;
  }
}
function ko(e) {
  console.log(`[deeplink]`, e);
  let t = Oo(e);
  if (!t) {
    ur();
    return;
  }
  let r = (n) => {
    n.show();
    let r = Z(n.webContents);
    if (t.hostname === `login-success`) {
      r.loginSuccess.send(t.searchParams.get(`token`) || ``);
    } else {
      r.deeplink.send(e);
    }
  };
  let i = n.getAllWindows();
  if (i.length > 0) {
    i.forEach((e) => {
      e.id;
      r(e);
    });
  } else {
    d.once(`windowReady`, (e) => {
      let t = n.fromWebContents(e.sender);
      if (t) {
        r(t);
      }
    });
  }
}
export {
  Qn as a,
  zn as c,
  me as d,
  Kn as i,
  X as l,
  Pa as n,
  Bn as o,
  ir as r,
  Hn as s,
  ho as t,
  he as u,
};
