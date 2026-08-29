/**
 * utils/selectionHandles.js — E4 选中对象的旋转/缩放手柄几何
 *
 * 渲染（planetDrawing.drawSelectionHandles）与命中检测（planetHitTest.hitTestSelectionHandle）
 * 共用同一套计算，避免两处手柄位置漂移。
 *
 * 约定：
 *  - rotation 存角度（degree，顺时针为正，Canvas 2D y 向下），scale 存无量纲倍数
 *  - 手柄/线宽尺寸用 zoom 反推世界坐标（屏幕常数大小）
 *  - 文本包围盒用 measureText 实测宽度（utils/textMeasure，与绘制背景框/命中框同源），
 *    保证手柄框与视觉文本边缘贴合
 */
import { measureLabelWidth, labelPadding } from './textMeasure';

// 手柄视觉尺寸（屏幕像素）
export const HANDLE_HIT_PX = 10;   // 命中半径
export const ROTATE_STEM_PX = 22;  // 旋转手柄支杆长度
export const ROTATE_R_PX = 5;      // 旋转手柄圆半径
export const SCALE_SIZE_PX = 8;    // 缩放手柄方形边长

/**
 * 选中对象的未旋转包围盒（世界坐标，已含 scale）
 * @returns {{ w: number, h: number, rot: number }}
 */
export function getSelectionBox(obj, kind) {
  const rot = ((obj.rotation || 0) * Math.PI) / 180;
  const scale = obj.scale || 1;
  if (kind === 'textLabel') {
    const fontSize = obj.fontSize || 16;
    const pad = labelPadding(fontSize);
    const w = (measureLabelWidth(obj.text || '', fontSize) + pad * 2) * scale;
    const h = (fontSize + pad) * scale;
    return { w, h, rot };
  }
  // marker：点 + 图标的视觉直径约 20
  const w = 20 * scale;
  return { w, h: w, rot };
}

/**
 * 旋转/缩放手柄的世界坐标位置
 * @returns {{ w, h, rot, rotate, rotateStemBase, scale }}
 */
export function getHandlePositions(obj, kind, zoom = 1) {
  const { w, h, rot } = getSelectionBox(obj, kind);
  const cs = Math.cos(rot), sn = Math.sin(rot);
  const local = (lx, ly) => ({ x: obj.x + lx * cs - ly * sn, y: obj.y + lx * sn + ly * cs });
  const stem = ROTATE_STEM_PX / zoom;
  return {
    w, h, rot,
    rotateStemBase: local(0, -h / 2),
    rotate: local(0, -h / 2 - stem),
    scale: local(w / 2, h / 2),
  };
}

/**
 * 手柄命中检测（屏幕常数半径）
 * @returns {'rotate'|'scale'|null}
 */
export function hitHandleAt(wx, wy, obj, kind, zoom = 1) {
  const hp = getHandlePositions(obj, kind, zoom);
  const r = HANDLE_HIT_PX / zoom;
  const dRotate = Math.hypot(wx - hp.rotate.x, wy - hp.rotate.y);
  if (dRotate <= r) return 'rotate';
  const hs = SCALE_SIZE_PX / zoom;
  if (Math.abs(wx - hp.scale.x) <= r && Math.abs(wy - hp.scale.y) <= r) return 'scale';
  return null;
}
