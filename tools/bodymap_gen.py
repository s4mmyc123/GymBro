import io, os

# Body map figure generator. Draws the front and back muscle-chart figure used by the
# Rotation tab (see DESIGN.md) and writes two preview pages into mockups/ (git-ignored).
# Run: python tools/bodymap_gen.py
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "mockups")
os.makedirs(OUT, exist_ok=True)
W, H = 240, 440
CX = 120

import math

def smooth(points, closed=True, tension=0.5, corners=False):
    """Catmull-Rom style curve through the points. With corners=True (tiles), a point where the path
    turns more than 55 degrees gets a zero tangent, so two tiles that share an edge produce the same
    curve along it (a rounded corner would overshoot 2 to 4 units into the neighbour and the shade
    gradients would stack there). The outline and the seams stay fully smooth."""
    n = len(points)
    if closed:
        def P(i): return points[i % n]
        rng = range(n)
    else:
        def P(i): return points[max(0, min(n - 1, i))]
        rng = range(n - 1)
    def tangent(i):
        p0, p1, p2 = P(i - 1), P(i), P(i + 1)
        if corners and p0 != p1 and p1 != p2:
            a = math.atan2(p1[1] - p0[1], p1[0] - p0[0])
            b = math.atan2(p2[1] - p1[1], p2[0] - p1[0])
            turn = abs((b - a + math.pi) % (2 * math.pi) - math.pi)
            if turn > math.radians(55):
                return (0.0, 0.0)
        return ((p2[0] - p0[0]) * tension / 3, (p2[1] - p0[1]) * tension / 3)
    d = f"M{P(0)[0]:.1f},{P(0)[1]:.1f} "
    for i in rng:
        p1, p2 = P(i), P(i + 1)
        t1, t2 = tangent(i), tangent(i + 1)
        c1 = (p1[0] + t1[0], p1[1] + t1[1])
        c2 = (p2[0] - t2[0], p2[1] - t2[1])
        d += f"C{c1[0]:.1f},{c1[1]:.1f} {c2[0]:.1f},{c2[1]:.1f} {p2[0]:.1f},{p2[1]:.1f} "
    return d + ("Z" if closed else "")

def M(pts): return [(2 * CX - x, y) for x, y in pts]

# ---------------- Landmarks (figure's right side, x < 120) ----------------
# Eight heads of 52: chin 60, shoulders 80, nipple 112, navel 164, crotch 220, knee 322, sole 424.
HEAD = (CX, 34, 19, 26)
# Neck ends in a V at the sternum notch (120, 86); the outline starts there, so the notch is drawn once.
NECK = [(106, 54), (134, 54), (134, 74), (120, 86), (106, 74)]   # 28 wide, three quarters of the head
NECK_SIDE = [(106, 60), (106, 71)]

# One closed outline for torso, arms and legs (this side, then mirrored). The arm is part of it so the
# shoulder/arm junction is one line, and the armpit is a notch in the outline. The outline is built per
# view from the same named lists; only the arm's medial contour and the neck-base point differ:
# the front shows the biceps belly and the sternum notch, the back the triceps long head and the nape.
# Arm widths, top to bottom: biceps belly 31, elbow 21, forearm flare 25, wrist 14, hand 22 with thumb.
# The lateral contour is nearly straight (delt notch, then lateral triceps); the front's medial contour
# carries a convex biceps belly peaking at y 148 (mid humerus); the back's is nearly straight from the
# armpit to the medial epicondyle with a faint triceps swell lower down (y 152 to 162), so from behind
# the biceps is barely there. Thigh is 49 wide, so the arm is about two thirds of it, as on a built physique.
# Joints: shoulder about y 100, elbow 172, wrist 232, fingertips 266 (mid thigh). Forearm 60 to humerus 72.
# Torso: armpit apex 76, lat flare widest at (73, 154) just under the armpit (the arm's inner contour is
# at 67 there, so the notch stays open), one convex sweep in to the waist at (80, 182), iliac crest at
# (78, 200), then the hip flares to the trochanter at (68, 262).
# Legs: knee 30 wide; lateral calf belly high (348), medial belly low and fuller (357); medial malleolus
# 3 units higher than the lateral; a 3 unit vastus medialis teardrop on the inner thigh at y 307.
ARM_OUT  = [(54, 120), (44, 134), (39, 148), (37, 160), (37, 172),    # delt notch, lateral triceps, lateral elbow
            (32, 186), (32, 200), (35, 218), (38, 232)]               # brachioradialis flare, taper, wrist
HAND     = [(35, 246), (39, 260), (45, 266), (51, 261), (55, 250), (57, 240)]   # knuckle, fingertips, thumb
ARM_IN_F = [(52, 232), (53, 220), (55, 206), (57, 190), (58, 172),    # wrist, forearm flexors, medial elbow
            (65, 160), (70, 148), (73, 137), (76, 128)]               # biceps belly (convex, peak at mid humerus), armpit
ARM_IN_B = ARM_IN_F[:5] + [(64, 162), (68, 152), (72, 140), (76, 128)]   # back: triceps long head, flatter and lower
TORSO    = [(75, 140), (73, 154), (76, 168), (80, 182), (78, 200), (72, 236)]   # armpit, lat flare, waist, iliac crest, hip
LEGS     = [(68, 262), (71, 296), (82, 322),                          # thigh outer (trochanter), knee (30 wide)
            (78, 348), (88, 402), (84, 412), (90, 424), (110, 424), (114, 412), (108, 399),   # lateral calf (high), lateral ankle (low), foot
            (115, 357), (112, 322), (117, 307), (114, 292), (116, 274), (118, 244), (118, 222)]   # medial calf (low, fuller), knee, vastus medialis, thigh, crotch
def R_of(arm_in):                                                     # neck base, trap slope (12 unit rise), acromion, delt cap, arm, hand, arm, torso, legs
    return [(106, 71), (90, 74), (72, 82), (58, 88), (52, 104)] + ARM_OUT + HAND + arm_in + TORSO + LEGS
OUTLINE = {"front": [(CX, 86)] + R_of(ARM_IN_F) + M(R_of(ARM_IN_F))[::-1],     # sternum notch
           "back":  [(CX, 77)] + R_of(ARM_IN_B) + M(R_of(ARM_IN_B))[::-1]}     # nape, a shallow dip

# Tiles. Each: (group id, points, mirror?). Ids are group ids, the same in both views.
# Tiles are clipped to the outline, so edges that lie on the outline overshoot it by 2 to 6 units;
# edges shared between two tiles use the same points (two interior points each) so the curves match.
CLAV   = [(120, 86), (102, 90), (88, 89)]                      # clavicle, notch to the pec / delt groove
PEC_O  = [(88, 89), (83, 100), (79, 114), (76, 128)]           # pec outer edge = front delt inner edge
PEC_B  = [(76, 128), (88, 133), (100, 135), (120, 134)]        # pec bottom (a third of a head under the nipple); rectus starts under it at x 100
DELT_X = [(78, 86), (69, 104), (64, 122), (62, 138)]           # front / side delt divider; front delt 10 wide at the clavicle, 15 at the belly
DELT_B = [(62, 138), (74, 140)]                                # delt insertion, tip to inner arm
ABS_O  = [(100, 135), (99, 150), (99, 165), (100, 183), (102, 214)]     # rectus outer edge: 40 wide column, narrowing to the pubis
ING    = [(74, 204), (88, 209), (102, 214), (118, 222)]        # inguinal V, hip to crotch
HIP_B  = [(69, 236), (87, 240), (104, 246), (118, 252)]        # hip band bottom = quad top; drops medially like the sartorius
KNEE   = [(80, 322), (97, 323), (114, 322)]
ELBOW  = [(34, 171), (48, 174), (61, 171)]                     # elbow: shallow V down (biceps tendon in front, olecranon behind)
WRIST  = [(36, 233), (45, 231), (54, 233)]
BI_LAT = [(62, 138), (52, 151), (46, 163), (43, 173)]          # front: biceps lateral edge, delt tip to the crease a quarter in from the epicondyle
TRI_Y  = [(62, 138), (57, 145), (52, 154), (47, 165), (44, 173)]   # back: lateral / long head groove, delt tip to the fork, then the lateral edge of the tendon flat
TRI_Y2 = [(52, 154), (54, 162), (55, 168), (54, 174)]          # back: medial edge of the tendon flat; with TRI_Y it draws the triceps horseshoe, open at the elbow
SIDE   = [(76, 182), (72, 168), (69, 154), (72, 140)]          # torso side overshoot, crest to armpit (used bottom-up by obliques and lats)
UPPER_ARM = [(51, 121), (62, 138), (74, 142), (73, 148), (68, 161)] + ELBOW[::-1] + [(34, 160), (36, 148), (41, 134)]
FOREARM   = ELBOW + [(60, 190), (58, 206), (56, 220)] + WRIST[::-1] + [(33, 218), (29, 200), (29, 186)]
LOWER_LEG = KNEE + [(118, 357), (110, 399), (86, 402), (75, 348)]
DELT_CAP  = [(51, 121), (48, 104), (55, 86), (69, 80)]        # delt cap along the outline, overshot

FRONT = [
    ("traps",      [(104, 68), (120, 80)] + CLAV + [(72, 82), (64, 78), (86, 70)], True),
    ("delt_side",  [(72, 82)] + DELT_X + DELT_CAP, True),
    ("delt_front", DELT_X[:1] + PEC_O + DELT_B[::-1] + DELT_X[2:0:-1], True),
    ("chest",      CLAV + PEC_O[1:] + PEC_B[1:], True),
    ("abs_upper",  ABS_O[:3] + [(120, 165), (120, 135)], True),
    ("abs_lower",  ABS_O[2:] + [(118, 222), (120, 224), (120, 165)], True),
    ("obliques",   PEC_B[:3] + ABS_O[1:] + ING[1::-1] + SIDE, True),
    ("hips",       ING + [(122, 236)] + HIP_B[::-1] + [(67, 220)], True),       # front: the inguinal band
    ("quads",      HIP_B + [(120, 266), (119, 290), (118, 308)] + KNEE[::-1] + [(69, 296), (65, 262)], True),
    ("calves",     LOWER_LEG, True),
    ("biceps",     UPPER_ARM, True),
    ("forearms",   FOREARM, True),
]

# Back. The trap kite's lateral point sits on the trap slope at x 84, a third of the way in from the
# acromion, so the shelf between it and the acromion belongs to the rear delt and the blades get a
# proper wedge under the kite. The shoulder cap is split like the front: DELT_XB from just above the
# acromion to the insertion tip divides side delt (lateral) from rear delt (medial).
KITE    = [(84, 74), (92, 90), (100, 100), (109, 124), (120, 148)]   # trap kite edge: slope, scapular spine, lower trap to T12
DELT_XB = [(73, 80), (66, 102), (62, 120), (62, 138)]            # side / rear delt divider, acromion to the insertion tip
RDELT   = [(92, 90), (83, 104), (74, 122), (62, 138)]            # rear delt lower edge, scapular spine to the insertion tip
UB_B    = [(76, 128), (90, 133), (106, 138)]                     # upper back bottom = lat top, sloping down to the erector
ERECT   = [(109, 124), (106, 138), (104, 158), (102, 180), (100, 202)]   # lat inner edge = erector column, widening to the sacrum
PELVIS  = [(76, 198), (96, 200), (108, 202), (120, 202)]         # iliac crest to the sacrum, about 3.8 heads
HIPX    = [(96, 200), (88, 214), (77, 227), (68, 237)]           # glute max upper border, crest to trochanter, a 3 unit bow; the hip (medius) wedge sits above it
FOLD    = [(68, 237), (86, 242), (104, 244), (118, 238)]         # gluteal fold, 0.4 head under the crotch
TB_R    = [(100, 66), (88, 70)] + KITE[:4]

BACK = [
    ("traps",      [(120, 72)] + TB_R + [(120, 148)] + M(TB_R)[::-1], False),
    ("delt_side",  [(73, 80)] + DELT_XB[1:] + DELT_CAP, True),
    ("delt_rear",  KITE[:2] + RDELT[1:] + DELT_XB[::-1][1:], True),
    ("upper_back", KITE[1:4] + UB_B[::-1] + RDELT[2:0:-1], True),                # blades, kite edge to the lat top
    ("lower_back", [(109, 124), (120, 148), (120, 202)] + ERECT[:0:-1], True),
    ("lats",       RDELT[2:] + [(74, 142)] + SIDE[::-1] + PELVIS[:2] + ERECT[:0:-1] + UB_B[1::-1], True),   # teres wedge into the armpit, flare, crest
    ("hips",       PELVIS[:2] + HIPX[1:] + [(62, 232), (66, 214), (70, 199)], True),   # back: outer hip, medius / tensor
    ("glutes",     [(96, 200), (108, 202), (121, 202), (121, 240)] + FOLD[::-1] + HIPX[:0:-1][1:], True),
    ("hamstrings", FOLD + [(120, 248), (119, 290), (118, 308)] + KNEE[::-1] + [(69, 296), (65, 262)], True),
    ("calves",     LOWER_LEG, True),
    ("triceps",    UPPER_ARM, True),
    ("forearms",   FOREARM, True),
]

# Seams: drawn once, on top, mirrored. Every seam starts and ends on another seam or just outside the
# outline (so it tucks under the edge stroke); none floats.
SEAMS_FRONT = [
    CLAV + [(70, 81)],                                        # clavicle
    PEC_O[:3] + [(76, 130)],                                  # pec outer / front delt inner
    DELT_X,                                                   # delt front / side divider, from the clavicle
    [(52, 119), (62, 138), (74, 142)],                        # delt insertion / biceps top
    BI_LAT,                                                   # biceps / lateral triceps edge
    [(76, 130)] + PEC_B[1:],                                  # pec bottom
    [(120, 86), (120, 222)],                                  # linea alba
    [(99, 150), (120, 150)], [(99, 165), (120, 165)], [(100, 183), (120, 183)],   # ab rows
    ABS_O,                                                    # abs / obliques
    ING[:3] + [(119, 223)],                                   # inguinal V (hip band top)
    HIP_B[:3] + [(119, 253)],                                 # hip band bottom / quad top
    [(83, 239), (81, 268), (85, 300), (93, 323)],             # quad sweep (vastus lateralis, a quarter of the thigh)
    KNEE, [(86, 402), (110, 399)], ELBOW, WRIST,              # knee, ankle (medial malleolus higher), elbow, wrist
]
SEAMS_BACK = [
    KITE,                                                     # trap kite edge, from just above the trap slope
    [(120, 75), (120, 224)],                                  # spine, from the nape
    DELT_XB,                                                  # side / rear delt divider
    RDELT,                                                    # rear delt lower edge, into the insertion V
    [(52, 119), (62, 138), (74, 142)],                        # delt insertion / triceps top
    TRI_Y, TRI_Y2,                                            # triceps horseshoe: groove to the fork, then the two edges of the tendon flat
    RDELT[2:3] + UB_B,                                        # upper back / lats, from the rear delt edge through the armpit apex
    ERECT,                                                    # lats / lower back
    PELVIS,                                                   # pelvis: lats and lower back / glutes and hips
    HIPX,                                                     # hips / glutes
    FOLD[:3] + [(119, 239)],                                  # gluteal fold
    [(93, 243), (89, 268), (94, 300), (99, 323)],             # biceps femoris / semitendinosus groove: bows out under the fold, in to the popliteal centre
    KNEE, [(86, 402), (110, 399)], ELBOW, WRIST,
]

STATUS = {"chest": "good", "delt_front": "good", "delt_side": "good", "delt_rear": "good", "biceps": "good", "triceps": "good",
          "traps": "good", "upper_back": "good", "lats": "good", "lower_back": "good",
          "abs_upper": "bad", "abs_lower": "bad",
          "quads": "warn", "hamstrings": "warn", "glutes": "warn", "hips": "warn", "calves": "warn"}

def figure(side, style="sculpt"):
    tiles = FRONT if side == "front" else BACK
    seams = SEAMS_FRONT if side == "front" else SEAMS_BACK
    cx, cy, rx, ry = HEAD
    body = smooth(OUTLINE[side])
    clip = f'clip-path="url(#clip-{side})"'
    out = f'<svg class="bodymap {style}" viewBox="0 0 {W} {H}" data-side="{side}">'
    out += f"""<defs>
      <linearGradient id="sh-{side}" x1="0" y1="0" x2="0.7" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.12"/><stop offset="0.55" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.18"/></linearGradient>
      <clipPath id="clip-{side}"><path d="{body}"/></clipPath>
    </defs>"""
    # 1. silhouette in the body tone
    out += f'<ellipse class="bm-body" cx="{cx}" cy="{cy}" rx="{rx}" ry="{ry}"/><path class="bm-body" d="{smooth(NECK)}"/>'
    out += f'<path class="bm-body" d="{body}"/>'
    # 2. tiles, clipped to the outline
    shapes = []
    for gid, pts, mir in tiles:
        for P in ([pts, M(pts)] if mir else [pts]):
            shapes.append((gid, smooth(P, corners=True)))
    for gid, d in shapes:
        st = STATUS.get(gid, "")
        out += f'<path class="bm-region {st}" data-region="{gid}" d="{d}" {clip}/>'
    if style == "sculpt":
        for gid, d in shapes:
            out += f'<path class="bm-shade" d="{d}" fill="url(#sh-{side})" {clip}/>'
        out += f'<ellipse class="bm-shade" cx="{cx}" cy="{cy}" rx="{rx}" ry="{ry}" fill="url(#sh-{side})"/>'
    # 3. seams, once; silhouette edge last
    for line in seams:
        for P in (line, M(line)):
            out += f'<path class="bm-seam" d="{smooth(P, closed=False)}"/>'
    out += f'<path class="bm-edge" d="{body}"/><ellipse class="bm-edge" cx="{cx}" cy="{cy}" rx="{rx}" ry="{ry}"/>'
    for P in (NECK_SIDE, M(NECK_SIDE)):
        out += f'<path class="bm-edge" d="{smooth(P, closed=False)}"/>'
    return out + "</svg>"

p = dict(bg="#0e0d0c", surface="#161514", body="#46413c", hair="#2a2826", text="#efeae2", dim="#9a948b", accent="#e08a3c", good="#7cc49a", warn="#e3c46a", bad="#e07070")

CSS = f"""
:root {{ --bg:{p['bg']}; --surface:{p['surface']}; --body:{p['body']}; --hair:{p['hair']}; --text:{p['text']}; --dim:{p['dim']}; --accent:{p['accent']}; --good:{p['good']}; --warn:{p['warn']}; --bad:{p['bad']}; }}
* {{ box-sizing:border-box; }}
body {{ margin:0 auto; max-width:1000px; background:#1a1a1a; color:#ddd; font-family:system-ui,-apple-system,'Segoe UI',sans-serif; padding:32px 24px 48px; }}
h1 {{ font-size:22px; color:#fff; margin:0 0 6px; }} p.intro {{ color:#aaa; max-width:720px; line-height:1.5; margin:0 0 24px; font-size:14px; }}
.cols {{ display:flex; gap:28px; flex-wrap:wrap; justify-content:center; align-items:flex-start; }}
.phone {{ width:375px; height:812px; background:var(--bg); color:var(--text); border:1px solid #333; overflow:hidden; padding:0 20px; font-size:14px; -webkit-font-smoothing:antialiased; }}
.hdr {{ padding:28px 0 14px; border-bottom:1px solid var(--hair); display:flex; justify-content:space-between; align-items:flex-start; }}
.hdr .mark {{ font-size:28px; font-weight:300; letter-spacing:-0.02em; line-height:1; }}
.label {{ font-size:11px; font-weight:600; color:var(--dim); text-transform:uppercase; letter-spacing:0.08em; }}
.hdr .label {{ margin-top:8px; }}
.logo {{ width:40px; height:40px; border:1px dashed var(--hair); }}
.section {{ padding:20px 0 22px; border-bottom:1px solid var(--hair); }}
.head {{ display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; }}
.readout {{ font-size:12.5px; color:var(--dim); margin-bottom:10px; }} .readout b {{ color:var(--text); font-weight:600; }}
.figs {{ display:flex; justify-content:space-evenly; gap:8px; }}
.figs > div {{ width:47%; }}
.bodymap {{ width:100%; height:auto; display:block; }}
.cap {{ font-size:11px; color:var(--dim); text-align:center; margin-top:6px; text-transform:uppercase; letter-spacing:0.08em; font-weight:600; }}
.bm-body {{ fill:var(--body); }}
.bm-region {{ fill:var(--body); }}
.bm-region.good {{ fill:var(--good); }} .bm-region.warn {{ fill:var(--warn); }} .bm-region.bad {{ fill:var(--bad); }}
.bm-shade {{ pointer-events:none; }}
.bm-seam {{ fill:none; stroke:var(--bg); stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }}
.bm-edge {{ fill:none; stroke:var(--bg); stroke-width:2.2; stroke-linejoin:round; }}
.rot {{ display:flex; align-items:center; gap:12px; padding:9px 0; }}
.rot .nm {{ width:84px; font-size:13.5px; }} .rot .nm small {{ display:block; font-size:11px; color:var(--dim); }}
.rot .st {{ width:56px; text-align:right; font-size:12.5px; font-weight:600; }}
.good {{ color:var(--good); }} .warn {{ color:var(--warn); }} .bad {{ color:var(--bad); }}
.ticks {{ flex:1; display:flex; gap:4px; }} .ticks i {{ flex:1; height:6px; background:var(--hair); display:block; }}
.ticks i.good {{ background:var(--good); }} .ticks i.warn {{ background:var(--warn); }} .ticks i.bad {{ background:var(--bad); }}
.big {{ display:flex; gap:24px; justify-content:center; background:var(--bg); padding:24px; }} .big .bodymap {{ width:340px; }}
"""

ROWS = [("Legs", 4, "warn"), ("Abs", None, "bad"), ("Chest", 0, "good"), ("Shoulders", 1, "good"), ("Arms", 1, "good"), ("Back", 2, "good")]
rows = ""
for name, d, st in ROWS:
    lit = 7 if d is None else min(7, d)
    rows += f'<div class="rot"><span class="nm">{name}<small>2×/wk</small></span><span class="ticks">' + "".join(f'<i class="{st if i < lit else ""}"></i>' for i in range(7)) + f'</span><span class="st {st}">{"Never" if d is None else "Today" if d == 0 else f"{d} day{"" if d == 1 else "s"}"}</span></div>'

html = f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Custom Fit mockup: body map, sculpted</title><style>{CSS}</style></head><body>
<h1>Body map: sculpted, reworked</h1>
<p class="intro">Option B rebuilt on the reviewer's fixes: one silhouette underneath, muscles as tiles that share edges, every seam drawn once in the background colour, arms rotated out, hips and thighs narrowed, crotch at four heads, glutes and hamstrings in proportion, the upper back as a band across the blades. The body tone is raised so untracked muscles read as part of the figure. A tap on a muscle names it in the line above the figures; the rows beneath are the source of truth.</p>
<div class="cols">
<div class="phone">
  <div class="hdr"><div><div class="mark">Rotation</div><div class="label">Wed 23 Sep</div></div><div class="logo"></div></div>
  <div class="section">
    <div class="head"><span class="label">Body map</span><span class="label">Tap a muscle</span></div>
    <div class="readout"><b>Quads</b> · due, 4 days since trained</div>
    <div class="figs"><div>{figure("front")}<div class="cap">Front</div></div><div>{figure("back")}<div class="cap">Back</div></div></div>
  </div>
  <div class="section"><div class="head"><span class="label">Muscle rotation</span></div>{rows}</div>
</div>
</div>
</body></html>"""
io.open(os.path.join(OUT, "19-bodymap-sculpted.html"), "w", encoding="utf-8", newline="\n").write(html)
big = f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sculpted, large</title><style>{CSS}</style></head><body><div class="big">{figure("front")}{figure("back")}</div></body></html>"""
io.open(os.path.join(OUT, "20-bodymap-sculpted-large.html"), "w", encoding="utf-8", newline="\n").write(big)
print("wrote 19 and 20")
