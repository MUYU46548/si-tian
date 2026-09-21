#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从知识库缓存**派生一份合成测试数据**（fixtures/vault-fixture/）。

为什么要它（2026-09-21 用户决策）：
    回归基线的 mock 数据一直是「复制真实库的 .sitian/*.json」→ 用户改自己的世界观数据，
    测试就可能变红（清掉一个测试残留节点就让 3 个用例失败）。测试应当只依赖**自己声明的 fixture**。
    用户原话：「直接编一套就行了，不需要用真实内容。」

    但「另编一套」如果与真实数据的形状差太多，55 个用例会集体变红 —— 所以本脚本的做法是
    **派生 + 脱敏**：保留层级结构/数量/分布等形状（用例依赖这些），把一切内容换掉：
      · 所有名字（节点 / 航道 / 底图 key / tags 里的专名）→ 虚构词表
      · sourcePath → `合成数据/...`
      · 坐标、地形多边形、区域多边形、标记、高度图网格 → 统一仿射 + 确定性抖动 / 镜像
      · terrainGrid（涂色层）→ 清空（255 = 未涂色），避免与变换后的几何错位
    结果：与真实库**无对应关系**（几何已变换、内容全替换），但形状同构 → 用例依赖全部满足。

用法：
    python scripts/tests/fixtures/make_vault_fixture.py            # 用默认库 E:/图书馆/ROSA
    python scripts/tests/fixtures/make_vault_fixture.py --vault D:/X --out <dir>
输出（入库，供 run_tests.py 默认使用）：
    scripts/tests/fixtures/vault-fixture/geodata.json
    scripts/tests/fixtures/vault-fixture/mapdata.json

⚠️ 重新生成只在「真实库结构发生有意义变化且需要 fixture 跟进」时做；平时用例应该只依赖 fixture。
"""
import argparse
import hashlib
import json
import math
import os
import random

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OUT = os.path.join(HERE, 'vault-fixture')

# ── 1. 关键节点：显式映射（用例直接引用这些名字，改一处即可）────────────────
KEY_NAMES = {
    '幻境': '潮汐界',          # 主测试世界（有星域子节点；test_09 下拉选它）
    '伏夜提加': '寂原',        # 空壳世界（无星域子节点，helpers 注释里提到的那个）
    '绒兽世界': '雪岭界',
    '粘土世界': '陶土界',
    '净土星域': '归岚星域',    # 主星域（曜川星系所在）
    '乐园星系': '曜川星系',    # 主星系（test_10/11/12/17 都用它）
    '乐园星': '曜川星',        # 主行星（108 处引用，行星地图挂它）
    '月球': '沧屿',            # 主行星的卫星（test_10 轨道顺序 / test_03 搜索）
    '庆云岛': '青螺岛',        # 区域节点（test_36）
    '两城流域': '双溪流域',    # 区域节点（planet 下第二个 region）
    '若空之境': '流岚之境',    # test_12 借用的「任意真实节点名」
    '丰竹镇': '苇塘镇',        # town 节点（test_30 标签渲染用它的名字）
    '哈伦的住所': '拾光小筑',  # test_22 wikilink 命中的两个节点之一
    '卡莉的工作室': '缄默工坊',  # test_22 另一个
}
# 非节点专名（只作为 wikilink 出现在正文里 → 搜索「提及」用例 test_22 用它）
NON_NODE_TERMS = {'白芝原': '叠翠原'}

# ── 2. 其余节点：虚构词表（确定性生成，保证唯一）──────────────────────────
SYL_A = ['霁', '澜', '墨', '霜', '炽', '隐', '朔', '砚', '翡', '穹', '榆', '燎', '岑', '漪',
         '岚', '砾', '槐', '眠', '烬', '沧', '沅', '潞', '珉', '瑄', '篷', '叙', '昙', '岩',
         '棹', '筠', '泊', '熹', '澹', '珩', '麓', '泠', '渠', '屿', '枢', '沅']
SYL_B = ['川', '屿', '垣', '涯', '垒', '洲', '阙', '壁', '涧', '坞', '原', '浔', '垠', '屏',
         '岭', '台', '埕', '渊', '陉', '浦', '垣', '矶', '濑', '垧', '岑', '岐', '峦', '湄']
SYL_C = ['哨', '台', '塔', '院', '堂', '井', '坊', '楼', '馆', '殿', '窑', '亭', '阁', '仓',
         '圃', '闸', '栈', '棚', '庙', '祠']


class Namer:
    """确定性虚构命名器（同输入 → 同名字；保证全局唯一、且**不与任何真实专名撞车**）。"""

    def __init__(self, real_names=None):
        self.used = set(KEY_NAMES.values()) | set(NON_NODE_TERMS.values()) | set(real_names or [])
        self.table = {}
        self.i = 0

    def __call__(self, original, layer=''):
        if original in KEY_NAMES:
            return KEY_NAMES[original]
        if original in self.table:
            return self.table[original]
        while True:
            i = self.i
            self.i += 1
            name = SYL_A[i % len(SYL_A)] + SYL_B[(i // len(SYL_A)) % len(SYL_B)]
            if layer in ('facility', 'location', 'building', 'city', 'town', 'village'):
                name += SYL_C[(i // (len(SYL_A) * len(SYL_B))) % len(SYL_C)]
            if name not in self.used:
                break
        self.used.add(name)
        self.table[original] = name
        return name


class NonNodeNamer:
    """正文 wikilink 里「不是节点名」的词 → 虚构词（保持「不是任何节点名」这一语义）。"""

    def __init__(self, node_names):
        self.node_names = set(node_names)
        self.table = {}
        self.i = 0

    def __call__(self, term):
        if term in NON_NODE_TERMS:
            return NON_NODE_TERMS[term]
        if term in self.node_names:
            return term  # 是节点名 → 交给节点映射（调用方处理）
        if term in self.table:
            return self.table[term]
        i = 1000 + self.i
        self.i += 1
        name = SYL_A[i % len(SYL_A)] + SYL_B[(i // len(SYL_A)) % len(SYL_B)] + '记'
        if name in self.node_names:
            name += '闻'
        self.table[term] = name
        return name


# ── 3. 节点坐标变换（纯平移：只让坐标值与真实库不同，不改布局结构）──────────
#    为什么不再旋转/缩放：地图几何已 100% 重新合成，节点坐标只需与「合成地图的覆盖范围」对齐。
ROT_DEG = 0.0
SCALE = 1.0
DX, DY = 137.0, -89.0


def xform(x, y, jitter=0.0, rnd=None):
    a = math.radians(ROT_DEG)
    nx = (x * math.cos(a) - y * math.sin(a)) * SCALE + DX
    ny = (x * math.sin(a) + y * math.cos(a)) * SCALE + DY
    if jitter and rnd:
        nx += rnd.uniform(-jitter, jitter)
        ny += rnd.uniform(-jitter, jitter)
    return int(round(nx)), int(round(ny))


def fake_uuid(seed):
    h = hashlib.md5(('sitian-fixture::' + seed).encode('utf-8')).hexdigest()
    return f'{h[0:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}'


def map_points(points, jitter, rnd):
    out = []
    for p in points or []:
        if isinstance(p, dict) and 'x' in p:
            nx, ny = xform(p['x'], p['y'], jitter, rnd)
            out.append({'x': nx, 'y': ny})
        elif isinstance(p, (list, tuple)) and len(p) >= 2:
            nx, ny = xform(p[0], p[1], jitter, rnd)
            out.append([nx, ny])
        else:
            out.append(p)
    return out


def make_scrubber(name_map):
    """按「长键优先」替换字符串里出现的真实专名（用于 id / 名字里嵌名字的字段）。"""
    keys = sorted((k for k in name_map if isinstance(k, str) and k), key=len, reverse=True)

    def scrub(s):
        if not isinstance(s, str):
            return s
        for k in keys:
            if k in s:
                s = s.replace(k, name_map[k])
        return s

    return scrub


def synth_map(planet_key, planet_name, cells_x=207, cells_y=130, spacing=14.4, seed=777):
    """**从零合成**一张行星地图（不基于真实地图做任何变换 —— 几何/高度图/多边形全部程序生成）。

    为什么不用「真实地图 + 仿射变换」：那仍是用户的作品轮廓（只是缩放平移），进公开仓库不妥；
    而且真数据里「涂色网格原点由高度图推导」是**持久化**的 —— 只改几何不改网格参数会让笔刷
    落在网格外（实测 test_21/test_38 直接红）。

    形状对齐（用例依赖）：网格同尺度（207×130 @ 14.4）、22 个稀疏地形小块、1 个区域、2 个标记、
    一个有海有陆的连续高度场（够智能聚落/河流/派生算法跑）。
    """
    rnd = random.Random(seed)
    ph = [rnd.uniform(0, 6.28) for _ in range(4)]
    # 网格原点取负值：让地图覆盖「原点附近的 ±1500 世界单位」区间，
    # 与节点坐标（提取脚本自动生成的同心圆，量级 ±1200）落在同一片区域里 —— 行星图才能把点画在图上。
    ox, oy = -1520.0, -1030.0
    h, temp, prec, biome = [], [], [], []
    for j in range(cells_y):
        for i in range(cells_x):
            x, y = i * spacing, j * spacing
            v = (40 + 26 * math.sin(x / 520 + ph[0]) * math.cos(y / 430 + ph[1])
                 + 14 * math.sin((x + y) / 170 + ph[2])
                 + 8 * math.sin((x - 2 * y) / 95 + ph[3]))
            v = max(0, min(100, int(round(v))))
            t = max(0, min(100, int(round(70 - (y / (cells_y * spacing)) * 90 + 12 * math.sin(x / 300 + ph[0])))))
            p = max(0, min(100, int(round(50 + 30 * math.sin(x / 210 + ph[1]) * math.cos(y / 180 + ph[2])))))
            h.append(v)
            temp.append(t)
            prec.append(p)
            # biome 索引（0..12）按温度/降水粗略映射，够派生算法用
            if v < 20:
                biome.append(0)                       # ocean
            elif t > 80 and p < 25:
                biome.append(1)                       # hot_desert
            elif t < 20:
                biome.append(11)                      # tundra
            elif p > 70:
                biome.append(6)                       # temperate_deciduous
            elif p > 45:
                biome.append(5)                       # grassland
            else:
                biome.append(3)                       # savanna

    grid_points = []
    for j in range(cells_y):
        for i in range(cells_x):
            grid_points.append([ox + i * spacing, oy + j * spacing])
    # 地形类型必须用**真实同一套 type 值**（英文枚举）：渲染取色 / SVG 图例都按 type 查表，
    # 换了值域就会「颜色变少 + 图例缺失」（首轮实测 test_06/test_45 直接红）。
    kind_seq = (['land'] * 8 + ['ocean'] * 3 + ['desert'] * 3 + ['volcano'] * 3
                + ['mountain'] * 2 + ['forest'] * 1 + ['lake'] * 1 + ['coast'] * 1)
    cn = {'land': '陆地', 'ocean': '海洋', 'desert': '沙漠', 'volcano': '火山',
          'mountain': '山脉', 'forest': '森林', 'lake': '湖泊', 'coast': '海岸'}
    rnd.shuffle(kind_seq)
    terrain = []
    seen = {}
    for n, kind in enumerate(kind_seq):
        seen[kind] = seen.get(kind, 0) + 1
        cxw = rnd.uniform(ox + 400, ox + (cells_x - 6) * spacing - 400)
        cyw = rnd.uniform(oy + 300, oy + (cells_y - 6) * spacing - 300)
        r = rnd.uniform(45, 165)
        verts = rnd.randint(6, 11)
        pts = []
        for k in range(verts):
            ang = 2 * math.pi * k / verts + rnd.uniform(-0.12, 0.12)
            rr = r * rnd.uniform(0.62, 1.18)
            pts.append({'x': int(round(cxw + rr * math.cos(ang))),
                        'y': int(round(cyw + rr * math.sin(ang)))})
        terrain.append({'id': f'poly_syn_{n}', 'points': pts, 'type': kind,
                        'name': f'{cn[kind]} {seen[kind]}', 'description': ''})

    region_c = (ox + (cells_x - 6) * spacing * 0.55, oy + (cells_y - 6) * spacing * 0.45)
    region_pts = []
    for k in range(30):
        ang = 2 * math.pi * k / 30
        rr = 190 * (1 + 0.25 * math.sin(3 * ang + rnd.uniform(-0.1, 0.1)))
        region_pts.append({'x': int(round(region_c[0] + rr * math.cos(ang))),
                           'y': int(round(region_c[1] + rr * math.sin(ang)))})

    # 涂色层（terrainGrid）：比高度图各外扩 16 格（EXTRA_CELLS）——与真数据同构。
    # 预置一部分涂色（确定性）而不是全空：画布颜色丰富度用例（test_06）要求画面有纹理层次，
    # 全空会让「唯一颜色数」掉到阈值以下（实测 26 < 30）。
    tg_w, tg_h = cells_x + 32, cells_y + 32
    tgrid = [255] * (tg_w * tg_h)
    for j in range(tg_h):
        for i in range(tg_w):
            hi, hj = i - 16, j - 16
            if 0 <= hi < cells_x and 0 <= hj < cells_y:
                if h[hj * cells_x + hi] >= 20 and rnd.random() < 0.35:
                    tgrid[j * tg_w + i] = rnd.randint(1, 8)

    return {
        'planetId': planet_name,
        'version': 1,
        'terrain': terrain,
        'regions': [{'id': 'region_syn_1', 'name': '区域 1', 'points': region_pts}],
        'markers': [
            {'id': 'marker_syn_1', 'type': 'chest', 'x': int(region_c[0]), 'y': int(region_c[1] - 500),
             'name': '宝箱 1', 'description': ''},
            {'id': 'marker_syn_2', 'type': 'teleport', 'x': int(region_c[0] - 500), 'y': int(region_c[1] - 500),
             'name': '传送点 1', 'description': ''},
        ],
        'updatedAt': '2026-01-01T00:00:00.000Z',
        'referenceImages': [],
        'heightmap': {
            'h': h, 'temp': temp, 'prec': prec, 'biome': biome,
            'grid': {'points': grid_points, 'spacing': spacing,
                     'cellsX': cells_x, 'cellsY': cells_y, 'count': cells_x * cells_y},
        },
        'terrainGrid': tgrid,
        'gridWidth': tg_w,
        'gridHeight': tg_h,
        'gridOriginX': ox - 16 * spacing,
        'gridOriginY': oy - 16 * spacing,
        'cellWorldSize': spacing,
    }


def build(geodata, mapdata, seed=20260921):
    rnd = random.Random(seed)
    real_names = {n.get('name') for n in geodata.get('nodes', []) if n.get('name')}
    namer = Namer(real_names)

    # 先给所有节点定名（wikilinks 需要完整映射表）
    name_map = {}
    layer_of = {}
    for n in geodata.get('nodes', []):
        nm = n.get('name') or n.get('id')
        fake = namer(nm, n.get('layer', ''))
        name_map[nm] = fake
        name_map[n.get('id')] = fake
        layer_of[nm] = n.get('layer', '')

    scrub = make_scrubber(name_map)
    non_node = NonNodeNamer(set(name_map.values()))

    def conv_link(term):
        """wikilink 目标的映射：非节点专名 → 专用映射；精确节点名 → 节点映射；
        含真实专名的派生词（如「xx文明」「xx之盟」）→ 按子串替换；其余 → 虚构非节点词。"""
        if term in NON_NODE_TERMS:
            return NON_NODE_TERMS[term]
        if term in name_map:
            return name_map[term]
        scrubbed = scrub(term)
        if scrubbed != term:
            return scrubbed
        return non_node(term)

    out_nodes = []
    for i, n in enumerate(geodata.get('nodes', [])):
        nm = n.get('name') or n.get('id')
        fake = name_map[nm]
        layer = n.get('layer', '')
        coord = n.get('coordinate') or {}
        nx, ny = xform(coord.get('x') or 0, coord.get('y') or 0, 0, rnd)
        tags = [scrub(t) for t in (n.get('tags') or [])]
        out = dict(n)
        out['id'] = fake
        out['name'] = fake
        out['parentId'] = name_map.get(n.get('parentId'), None) if n.get('parentId') else None
        out['tags'] = tags
        out['sourcePath'] = f'合成数据/{layer or "其它"}/{fake}.md'
        out['wikilinks'] = [conv_link(w) for w in (n.get('wikilinks') or [])]
        out['coordinate'] = {'x': nx, 'y': ny}
        out['uuid'] = fake_uuid(f'{nm}#{i}')
        out_nodes.append(out)

    out_geodata = dict(geodata)
    out_geodata['nodes'] = out_nodes
    out_geodata['hyperlanes'] = [
        {**h,
         # ⚠️ hyperlane 的端点是 fromId / toId（不是 from / to）—— 改名漏了它 = 航道指向不存在的节点
         'fromId': name_map.get(h.get('fromId'), h.get('fromId')),
         'toId': name_map.get(h.get('toId'), h.get('toId')),
         'id': scrub(h.get('id')) or f'lane_fx_{i}'}
        for i, h in enumerate(geodata.get('hyperlanes', []))
    ]
    for key in ('domainBorderOverrides', 'interiorData', 'areaZones', 'areaRoutes',
                'areaMarkers', 'areaTextLabels', 'areaReferenceImages',
                'interiorReferenceImages', 'spaceMarkers', 'fleetCards'):
        if key in out_geodata and isinstance(out_geodata[key], dict):
            out_geodata[key] = {name_map.get(k, k): v for k, v in out_geodata[key].items()}

    # ── 地图数据：**从零合成**（不基于真实地图做任何变换，见 synth_map 的注释）────
    #    真实地图的几何与高度图是用户的作品内容，不该以任何形式进公开仓库；
    #    而「只改几何不改「网格参数」会让笔刷落在网格外（test_21/test_38 实测红）——
    #    所以这里连网格一起重新生成，参数自洽。
    out_map = {}
    if mapdata:
        key = next(iter(mapdata.keys()))
        world = key.split('/')[0]
        src = mapdata[key]
        planet = src.get('planetId') or key.split('/')[-1]
        g = ((src.get('heightmap') or {}).get('grid') or {})
        new_key = f'{name_map.get(world, world)}/{name_map.get(planet, planet)}'
        out_map[new_key] = synth_map(
            new_key, name_map.get(planet, planet),
            cells_x=int(g.get('cellsX') or 207),
            cells_y=int(g.get('cellsY') or 130),
            spacing=float(g.get('spacing') or 14.4),
        )

    return out_geodata, out_map


def assert_no_leak(out_g, out_m, real_names):
    """硬闸门：合成 fixture 里不得残留任何真实专名（防「脱敏漏一处」静默泄露到公开仓库）。"""
    blob = json.dumps([out_g, out_m], ensure_ascii=False)
    leaked = sorted({n for n in real_names if n and len(n) >= 2 and n in blob})
    if leaked:
        raise SystemExit('❌ fixture 仍含真实专名（脱敏不完整）：' + '、'.join(leaked[:20]))
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--vault', default=os.environ.get('SITIAN_VAULT', r'E:/图书馆/ROSA'))
    ap.add_argument('--out', default=DEFAULT_OUT)
    args = ap.parse_args()

    gp = os.path.join(args.vault, '.sitian', 'geodata.json')
    mp = os.path.join(args.vault, '.sitian', 'mapdata.json')
    geodata = json.load(open(gp, encoding='utf-8'))
    mapdata = json.load(open(mp, encoding='utf-8')) if os.path.exists(mp) else {}

    out_g, out_m = build(geodata, mapdata)
    real_names = {n.get('name') for n in geodata.get('nodes', []) if n.get('name')}
    real_names |= set(NON_NODE_TERMS.keys())
    # 真实底图/剧本 key 也算内容（只查 baseMap 名，不查 desite 这类短词避免误报）
    real_names |= {'德斯特星'}
    assert_no_leak(out_g, out_m, real_names)

    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, 'geodata.json'), 'w', encoding='utf-8') as f:
        json.dump(out_g, f, ensure_ascii=False, indent=1)
    with open(os.path.join(args.out, 'mapdata.json'), 'w', encoding='utf-8') as f:
        json.dump(out_m, f, ensure_ascii=False)

    names = [n['name'] for n in out_g['nodes']]
    print(f'合成 fixture 已生成 → {args.out}')
    print(f'  节点 {len(names)} / 航道 {len(out_g.get("hyperlanes") or [])} / 行星图 {list(out_m.keys())}')
    print(f'  世界 {[n["name"] for n in out_g["nodes"] if n["layer"] == "world"]}')
    print(f'  星域 {[n["name"] for n in out_g["nodes"] if n["layer"] == "star_domain"][:3]} …')
    print('  ✅ 脱敏闸门：输出中不含任何真实专名')


if __name__ == '__main__':
    main()
