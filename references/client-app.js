(function () {
  try {
    var e =
      typeof window != "undefined"
        ? window
        : typeof global != "undefined"
          ? global
          : typeof globalThis != "undefined"
            ? globalThis
            : typeof self != "undefined"
              ? self
              : {};
    var n = new e.Error().stack;
    if (n) {
      e._posthogChunkIds = e._posthogChunkIds || {};
      e._posthogChunkIds[n] = "019dca39-fe1b-74d3-8fdc-327971e06e13";
    }
  } catch (e) {}
})();
const __vite__mapDeps = (
  i,
  m = __vite__mapDeps,
  d = (m.f ||= [
    "_app/immutable/nodes/0.B-THE0LT.js",
    "_app/immutable/chunks/C0-Sg4Zo.js",
    "_app/immutable/chunks/B4gD-mGQ.js",
    "_app/immutable/chunks/CrP897dy.js",
    "_app/immutable/chunks/BgIK4H_S.js",
    "_app/immutable/chunks/CpWfWUHL.js",
    "_app/immutable/chunks/CSqTKQw8.js",
    "_app/immutable/chunks/DXE32dZW.js",
    "_app/immutable/chunks/CBB8d3n5.js",
    "_app/immutable/chunks/BIEoCE_3.js",
    "_app/immutable/chunks/f79z4Nhz.js",
    "_app/immutable/chunks/8-LEmzIm.js",
    "_app/immutable/chunks/CuyqONxg.js",
    "_app/immutable/chunks/DqgeXCxM.js",
    "_app/immutable/chunks/B02w6TtC.js",
    "_app/immutable/chunks/DpQHO9IL.js",
    "_app/immutable/chunks/CyUXIfu0.js",
    "_app/immutable/chunks/DMwF4_R-.js",
    "_app/immutable/chunks/CNhVczMp.js",
    "_app/immutable/chunks/B_uHyfqS.js",
    "_app/immutable/chunks/CVrXv1FQ.js",
    "_app/immutable/assets/0.BOuFn8nO.css",
    "_app/immutable/nodes/1.D7UnzGRp.js",
    "_app/immutable/chunks/BYkX8wu9.js",
    "_app/immutable/nodes/2.D6JLdZH7.js",
    "_app/immutable/chunks/CXW65I1a.js",
    "_app/immutable/chunks/BYRHE6A_.js",
    "_app/immutable/chunks/B9B9ph8X2.js",
    "_app/immutable/chunks/Bv2bhLVp.js",
    "_app/immutable/chunks/sEmcTkU32.js",
    "_app/immutable/chunks/BfMRbBM1.js",
    "_app/immutable/assets/2.Czs7gchL.css",
    "_app/immutable/nodes/3.CR-skh49.js",
    "_app/immutable/chunks/DLterouu.js",
    "_app/immutable/chunks/CGH8kVtb2.js",
    "_app/immutable/chunks/DC8eXDki2.js",
    "_app/immutable/chunks/Im2DErPe2.js",
    "_app/immutable/chunks/CNop91uz2.js",
    "_app/immutable/chunks/DmAerkdA2.js",
    "_app/immutable/assets/spinner.BTpnGYeE.css",
    "_app/immutable/chunks/DySzV5DP2.js",
    "_app/immutable/chunks/CpaIpA0J.js",
    "_app/immutable/chunks/DJ0iUUNh2.js",
    "_app/immutable/chunks/h4iEg6YW2.js",
    "_app/immutable/chunks/CDpoXI7Z2.js",
    "_app/immutable/chunks/lLFeHN5h2.js",
    "_app/immutable/chunks/BB9c3ZRB2.js",
    "_app/immutable/chunks/BmKDOPzb2.js",
    "_app/immutable/chunks/Bhty8KHD2.js",
    "_app/immutable/chunks/Qk43rnqA2.js",
    "_app/immutable/chunks/DnV-nf762.js",
    "_app/immutable/chunks/B2xNFMRX2.js",
    "_app/immutable/chunks/CWRWp-d1.js",
    "_app/immutable/chunks/Ct-SGhHJ.js",
    "_app/immutable/chunks/DwQXxPt-2.js",
    "_app/immutable/chunks/VqhqnPrC.js",
    "_app/immutable/chunks/BWzdDHBG2.js",
    "_app/immutable/chunks/DUhK1iNF2.js",
    "_app/immutable/chunks/BIHZfB2l2.js",
    "_app/immutable/assets/3.C3mfVaZU.css",
    "_app/immutable/nodes/4.D5oaN9R_.js",
    "_app/immutable/nodes/5.BZmMgLUO.js",
    "_app/immutable/chunks/tIL78AmN.js",
    "_app/immutable/chunks/DYHoV2R1.js",
    "_app/immutable/nodes/6.jaJ6Tc-G.js",
    "_app/immutable/chunks/DIdsh5aW.js",
    "_app/immutable/nodes/7.CU4aHgCp.js",
    "_app/immutable/nodes/8.JFWA1QBM.js",
    "_app/immutable/chunks/CbNy4ZA_.js",
    "_app/immutable/nodes/9.b5DwhJ0J.js",
    "_app/immutable/nodes/10.CWwwW2YX.js",
    "_app/immutable/nodes/11.Cxks7zH5.js",
  ]),
) => i.map((i) => d[i]);
import "../chunks/C0-Sg4Zo.js";
import {
  E as e,
  Et as t,
  F as n,
  H as r,
  J as i,
  L as a,
  M as o,
  Nt as s,
  R as c,
  Tt as l,
  X as u,
  _t as d,
  a as f,
  ct as p,
  ht as m,
  i as h,
  l as g,
  lt as _,
  nt as v,
  pt as y,
  r as b,
  rt as x,
  tt as S,
  ut as C,
  z as w,
} from "../chunks/CrP897dy.js";
import { t as T } from "../chunks/CBB8d3n5.js";
import "../chunks/CpWfWUHL.js";
import { U as E, cn as D, ln as O, un as k } from "../chunks/DXE32dZW.js";
import { n as A } from "../chunks/DMwF4_R-.js";
import "../chunks/CuyqONxg.js";
O();
var j = ({ error: e, status: t }) => {
  console.error(e);
  if (t !== 404) {
    A(e);
  }
};
var M = async () => {
  let [e, t] = await Promise.all([
    api.getAccentColor(),
    api.getLocalSettings(),
  ]);
  inlineScriptApi.initAccent(e);
  E.setQueryData(k.localSettings, t);
  D();
};
var N = {};
var P = w(
  `<div id="svelte-announcer" aria-live="assertive" aria-atomic="true" style="position: absolute; left: 0; top: 0; clip: rect(0 0 0 0); clip-path: inset(50%); overflow: hidden; white-space: nowrap; width: 1px; height: 1px"><!></div>`,
);
var F = w(`<!> <!>`, 1);
function I(h, w) {
  t(w, true);
  let T = f(w, `components`, 23, () => []);
  let E = f(w, `data_0`, 3, null);
  let D = f(w, `data_1`, 3, null);
  let O = f(w, `data_2`, 3, null);
  x(() => w.stores.page.set(w.page));
  v(() => {
    w.stores;
    w.page;
    w.constructors;
    T();
    w.form;
    E();
    D();
    O();
    w.stores.page.notify();
  });
  let k = m(false);
  let A = m(false);
  let j = m(null);
  b(() => {
    let e = w.stores.page.subscribe(() => {
      if (i(k)) {
        y(A, true);
        u().then(() => {
          y(j, document.title || `untitled page`, true);
        });
      }
    });
    y(k, true);
    return e;
  });
  let M = d(() => w.constructors[2]);
  var N = F();
  var I = _(N);
  var L = (t) => {
    let n = d(() => w.constructors[0]);
    var r = c();
    e(
      _(r),
      () => i(n),
      (t, n) => {
        g(
          n(t, {
            get data() {
              return E();
            },
            get form() {
              return w.form;
            },
            get params() {
              return w.page.params;
            },
            children: (t, n) => {
              var r = c();
              var s = _(r);
              var l = (t) => {
                let n = d(() => w.constructors[1]);
                var r = c();
                e(
                  _(r),
                  () => i(n),
                  (t, n) => {
                    g(
                      n(t, {
                        get data() {
                          return D();
                        },
                        get form() {
                          return w.form;
                        },
                        get params() {
                          return w.page.params;
                        },
                        children: (t, n) => {
                          var r = c();
                          e(
                            _(r),
                            () => i(M),
                            (e, t) => {
                              g(
                                t(e, {
                                  get data() {
                                    return O();
                                  },
                                  get form() {
                                    return w.form;
                                  },
                                  get params() {
                                    return w.page.params;
                                  },
                                }),
                                (e) => (T()[2] = e),
                                () => T()?.[2],
                              );
                            },
                          );
                          a(t, r);
                        },
                        $$slots: {
                          default: true,
                        },
                      }),
                      (e) => (T()[1] = e),
                      () => T()?.[1],
                    );
                  },
                );
                a(t, r);
              };
              var u = (t) => {
                let n = d(() => w.constructors[1]);
                var r = c();
                e(
                  _(r),
                  () => i(n),
                  (e, t) => {
                    g(
                      t(e, {
                        get data() {
                          return D();
                        },
                        get form() {
                          return w.form;
                        },
                        get params() {
                          return w.page.params;
                        },
                      }),
                      (e) => (T()[1] = e),
                      () => T()?.[1],
                    );
                  },
                );
                a(t, r);
              };
              o(s, (e) => {
                if (w.constructors[2]) {
                  e(l);
                } else {
                  e(u, -1);
                }
              });
              a(t, r);
            },
            $$slots: {
              default: true,
            },
          }),
          (e) => (T()[0] = e),
          () => T()?.[0],
        );
      },
    );
    a(t, r);
  };
  var R = (t) => {
    let n = d(() => w.constructors[0]);
    var r = c();
    e(
      _(r),
      () => i(n),
      (e, t) => {
        g(
          t(e, {
            get data() {
              return E();
            },
            get form() {
              return w.form;
            },
            get params() {
              return w.page.params;
            },
          }),
          (e) => (T()[0] = e),
          () => T()?.[0],
        );
      },
    );
    a(t, r);
  };
  o(I, (e) => {
    if (w.constructors[1]) {
      e(L);
    } else {
      e(R, -1);
    }
  });
  var z = C(I, 2);
  var B = (e) => {
    var t = P();
    var c = p(t);
    var l = (e) => {
      var t = r();
      S(() => n(t, i(j)));
      a(e, t);
    };
    o(c, (e) => {
      if (i(A)) {
        e(l);
      }
    });
    s(t);
    a(e, t);
  };
  o(z, (e) => {
    if (i(k)) {
      e(B);
    }
  });
  a(h, N);
  l();
}
var L = h(I);
var R = [
  () =>
    T(
      () => import(`../nodes/0.B-THE0LT.js`),
      __vite__mapDeps([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
        20, 21,
      ]),
    ),
  () =>
    T(
      () => import(`../nodes/1.D7UnzGRp.js`),
      __vite__mapDeps([22, 23, 2, 3, 1, 12, 20]),
    ),
  () =>
    T(
      () => import(`../nodes/2.D6JLdZH7.js`),
      __vite__mapDeps([
        24, 2, 3, 1, 25, 12, 26, 27, 14, 6, 28, 29, 5, 30, 23, 31,
      ]),
    ),
  () =>
    T(
      () => import(`../nodes/3.CR-skh49.js`),
      __vite__mapDeps([
        32, 1, 2, 3, 8, 33, 7, 5, 6, 9, 10, 11, 13, 34, 12, 26, 35, 36, 37, 38,
        39, 40, 23, 41, 4, 42, 43, 44, 45, 46, 47, 27, 14, 28, 29, 48, 49, 50,
        51, 52, 20, 53, 54, 55, 56, 16, 15, 17, 18, 57, 30, 58, 19, 59,
      ]),
    ),
  () =>
    T(
      () => import(`../nodes/4.D5oaN9R_.js`),
      __vite__mapDeps([60, 38, 3, 1, 12, 26, 39, 55, 6, 9]),
    ),
  () =>
    T(
      () => import(`../nodes/5.BZmMgLUO.js`),
      __vite__mapDeps([
        61, 2, 3, 1, 36, 6, 12, 43, 7, 8, 5, 9, 10, 11, 26, 62, 27, 14, 28, 29,
        63, 55, 51, 52, 20,
      ]),
    ),
  () =>
    T(
      () => import(`../nodes/6.jaJ6Tc-G.js`),
      __vite__mapDeps([
        64, 1, 33, 7, 2, 3, 8, 5, 6, 9, 10, 11, 13, 34, 12, 26, 36, 65, 52, 28,
        29, 20, 38, 39, 45, 46, 25, 47, 27, 14, 48, 63, 55, 40, 23, 17, 18,
      ]),
    ),
  () =>
    T(
      () => import(`../nodes/7.CU4aHgCp.js`),
      __vite__mapDeps([
        66, 43, 7, 1, 2, 3, 8, 5, 6, 9, 10, 11, 12, 26, 62, 36, 27, 14, 28, 29,
        63, 55, 13,
      ]),
    ),
  () =>
    T(
      () => import(`../nodes/8.JFWA1QBM.js`),
      __vite__mapDeps([
        67, 36, 6, 3, 1, 12, 68, 47, 27, 14, 28, 29, 26, 48, 41, 4, 5, 2, 7, 8,
        9, 10, 11, 42, 43, 65, 52, 20, 44, 34, 38, 39, 63, 55, 54, 40, 23,
      ]),
    ),
  () =>
    T(
      () => import(`../nodes/9.b5DwhJ0J.js`),
      __vite__mapDeps([
        69, 33, 7, 1, 2, 3, 8, 5, 6, 9, 10, 11, 13, 34, 12, 26, 68, 47, 27, 14,
        28, 29, 48, 65, 52, 20, 45, 38, 39, 49, 43, 50, 63, 55, 53, 54, 40, 23,
        15, 16, 57, 17, 18,
      ]),
    ),
  () =>
    T(
      () => import(`../nodes/10.CWwwW2YX.js`),
      __vite__mapDeps([
        70, 42, 4, 5, 1, 2, 3, 6, 7, 8, 9, 10, 11, 12, 43, 26, 65, 52, 28, 29,
        20, 45, 38, 39, 47, 27, 14, 48, 50, 63, 55, 53, 54, 40, 23,
      ]),
    ),
  () =>
    T(
      () => import(`../nodes/11.Cxks7zH5.js`),
      __vite__mapDeps([
        71, 2, 3, 1, 35, 12, 26, 36, 6, 41, 4, 5, 7, 8, 9, 10, 11, 65, 52, 28,
        29, 20, 38, 39, 45, 47, 27, 14, 48, 49, 43, 50, 63, 55, 51, 53, 54, 56,
        16, 40, 23,
      ]),
    ),
];
var z = [];
var B = {
  "/": [3],
  "/in-app-browser": [4],
  "/settings": [5, [2]],
  "/settings/advanced": [6, [2]],
  "/settings/appearance": [7, [2]],
  "/settings/extensions": [8, [2]],
  "/settings/mcp": [9, [2]],
  "/settings/prompts": [10, [2]],
  "/settings/providers": [11, [2]],
};
var V = {
  handleError:
    j ||
    (({ error: e }) => {
      console.error(e);
    }),
  init: M,
  reroute: () => {},
  transport: {},
};
var H = Object.fromEntries(
  Object.entries(V.transport).map(([e, t]) => [e, t.decode]),
);
var U = Object.fromEntries(
  Object.entries(V.transport).map(([e, t]) => [e, t.encode]),
);
var W = false;
var G = (e, t) => H[e](t);
export {
  G as decode,
  H as decoders,
  B as dictionary,
  U as encoders,
  W as hash,
  V as hooks,
  N as matchers,
  R as nodes,
  L as root,
  z as server_loads,
};
//# sourceMappingURL=app.BpWP3kTK.js.map
//# chunkId=019dca39-fe1b-74d3-8fdc-327971e06e13
