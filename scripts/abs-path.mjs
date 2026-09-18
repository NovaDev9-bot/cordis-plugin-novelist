/**
 * abs-path.mjs —— 「内嵌绝对路径」的跨平台识别（装配器自证与它的回归测试**共用一份**）
 *
 * 为什么单独成文件（2026-09-19 实证）：这段正则此前被**抄了两份**
 * （`build-wb-expert.mjs` 的等价性自证、`build-wb-expert.test.mjs` 的断言），
 * 而且两份都只认 Windows 盘符 `[A-Za-z]:\\…`。后果是 **linux CI 直接红**：
 * Linux 的绝对路径是 `/home/runner/…`，根本不会被剥掉 → 内置手册与真源"去路径后逐字一致"
 * 永远不成立 → 装配器 die → 四条回归全灭；而本机（Windows）全绿，看不出来。
 *
 * 这正是本仓反复吃的那个形状：**同一事实两处实现 = 静默分叉**。所以这里只留一份。
 *
 * 两个分支：
 *  ① Windows 盘符：`C:\…` 或 `C:/…`（历史行为，原样保留）
 *  ② POSIX 绝对路径：/ 起头，且**至少两段**（`/a/b`）——只认一段会把正文里
 *     "A/B 两种给法"这类行文斜杠误判成路径。前置断言再挡掉紧跟在词字符/点/横线/
 *     斜杠/星号后面的斜杠，避免把通配写法与相对写法（editorial/x）卷进来。
 */
export const ABSPATH_SRC =
  '(?:[A-Za-z]:[\\\\/][^\\s\\u4e00-\\u9fff`）"\'*，。；—、]+'
  + '|(?<![\\w.\\-/*])/(?:[\\w.\\-]+/)+[\\w.\\-]+)'

/** 把绝对路径替换成 <PATH>（用于"内容有没有漂移"的逐字比较） */
export const stripAbsPaths = (s) => s.replace(new RegExp(ABSPATH_SRC, 'g'), '<PATH>')

/** 取出文本里出现过的绝对路径（去重，用于"每条都真的存在"的存在性断言） */
export const absPaths = (s) => [...new Set(s.match(new RegExp(ABSPATH_SRC, 'g')) || [])]
