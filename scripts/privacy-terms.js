// scripts/privacy-terms.js — 私人专名表（base64；明文不落库，避免扫描器自己成为泄漏源）
//
// 为什么编码：扫描器若把“要防的词”明文写在仓库里，**它自己就是最大的泄漏点**。
// 这里只存 base64；`privacy-scan.mjs` 与 `test_107_no_real_names_in_ui.py` 都从这里读同一份，
// 不再各写一份黑名单（两份清单迟早漂移）。
//
// 需要加词：改下面的 B64（`node -e "console.log(Buffer.from(JSON.stringify({terms:[...]}),'utf8').toString('base64'))"`），
// 或者临时用 `--terms a,b` 跑扫描器（不改仓）。
'use strict';

const B64 = 'eyJ0ZXJtcyI6IFsi57uS6Iqx6K6h5YiSIiwgIue7kuiKsSIsICLlvrfmlq/nibkiLCAi5LyP5aSc5o+Q5YqgIiwgIuS5kOWbreaYn+WOhiIsICLlh4DlnJ/mmJ/ln58iLCAi5p2+5bKa5pif5Z+fIiwgIuefpeWwmOaYn+WfnyIsICLnoJrkuLTmmJ/ln58iLCAi57ui6K+65pif5Z+fIiwgIuikquWiqOaYn+WfnyIsICLnjqXlm70iLCAiQzpcXFVzZXJzXFxtdXl1IiwgIkU6XFzlm77kuabppoYiLCAiUk9TQSIsICJFOlxcXFzlm77kuabppoYiLCAiQzpcXFxcVXNlcnNcXFxcbXV5dSIsICJFOi/lm77kuabppoYiLCAiQzovVXNlcnMvbXV5dSIsICLnk6/njovmnJ0iLCAi5YGD546L5pydIiwgIueOpueOi+acnSIsICLpg5Hlm73nurfkuokiXX0=';

function decodeTerms() {
  try {
    const obj = JSON.parse(Buffer.from(B64, 'base64').toString('utf8'));
    return Array.isArray(obj && obj.terms) ? obj.terms.slice() : [];
  } catch (_) {
    return [];
  }
}

module.exports = { B64, decodeTerms };
