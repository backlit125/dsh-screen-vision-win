/**
 * 语言化层 —— 把一帧的结构化语义合成面向 LLM 的自然语言摘要。
 *
 * 目标不是「描述每个像素」，而是回答三个问题：
 *   现在在哪 / 刚发生了什么 / 用户注意力在哪。
 * 文案完全由结构化字段驱动（模板化生成，无幻觉来源），并带窗口内的
 * 事件流回顾，让单次 vision_read 也能拿到「最近历史」。
 */

/**
 * 前台应用友好名。Windows 版以进程名（不含扩展名）为 key；同时保留 Android 包名
 * 别名，让语义层在两平台上共用同一份代码。
 */
const PKG_ALIAS = {
  "DeepSeek Harness": "DeepSeek Harness",
  "chrome": "Chrome 浏览器",
  "msedge": "Edge 浏览器",
  "explorer": "资源管理器",
  "SearchApp": "开始菜单搜索",
  "SearchHost": "开始菜单搜索",
  "WindowsTerminal": "终端",
  "Code": "VS Code",
  "idea64": "IntelliJ IDEA",
  "python": "Python",
  "QQ": "QQ",
  "Weixin": "微信",
  "WeChat": "微信",
  "TWDT": "Twitter",
  "Discord": "Discord",
  "Slack": "Slack",
  "firefox": "Firefox",
  "opera": "Opera",
  "Taskmgr": "任务管理器",
  "notepad": "记事本",
  "POWERPNT": "PowerPoint",
  "WINWORD": "Word",
  "EXCEL": "Excel",
  "Photoshop": "Photoshop",
  "gimp-2.99": "GIMP",
  "Premiere Pro": "Premiere Pro",
  "com.android.systemui": "系统界面",
  "com.tencent.mm": "微信",
  "com.tencent.mobileqq": "手机QQ",
  "com.android.browser": "系统浏览器",
  "com.android.chrome": "Chrome 浏览器",
  "com.miui.home": "桌面",
  "com.android.launcher": "桌面",
  "com.bilibili.app": "哔哩哔哩",
  "tv.danmaku.bili": "哔哩哔哩",
  "com.ss.android.article.news": "今日头条",
  "com.zhihu.android": "知乎",
  "com.deepseek.harness": "DeepSeek Harness",
};

export function pkgName(pkg) {
  if (!pkg) return "未知应用";
  return PKG_ALIAS[pkg] || pkg;
}

/**
 * 生成自然语言摘要。
 * @param {object} f - 一帧完整语义（FrameStore 里存的 frame 对象）。
 * @param {Array} recentEvents - 最近窗口内的事件（时间正序）。
 */
export function narrate(frame, recentEvents = []) {
  const parts = [];
  const pkg = pkgName(frame.source_window);
  const hasTree = frame.ui_elements !== null && frame.ui_elements !== undefined;

  // 1) 现在在哪
  if (frame.privacy_masked) {
    parts.push(`当前前台为 ${pkg}（隐私名单应用，内容已遮蔽）。`);
  } else if (hasTree) {
    parts.push(`当前前台是 ${pkg}${frame.viewport && frame.viewport.width ? `，屏幕 ${frame.viewport.width}×${frame.viewport.height}px` : ""}。`);
  } else {
    parts.push(`当前前台是 ${pkg}（控件树不可读，仅像素感知）。`);
  }

  // 2) 刚发生了什么（事件流）
  const evParts = [];
  for (const e of recentEvents) {
    switch (e.type) {
      case "scroll":
        if (e.scroll_event) {
          evParts.push(`页面正${e.scroll_event.direction === "down" ? "向下" : "向上"}滚动` +
            `（约 ${e.scroll_event.displacementPx}px，速度约 ${e.scroll_event.speedPxPerSec}px/s）`);
        } else if (e.summary) { evParts.push(e.summary); }
        break;
      case "window_switch":
        evParts.push(`从 ${pkgName(e.from)} 切换到了 ${pkgName(e.to)}`);
        break;
      case "content_change":
        if (e.added_texts && e.added_texts.length) {
          evParts.push(`新增了 ${e.added_texts.length} 条内容（如「${e.added_texts[0]}」）`);
        } else { evParts.push(e.summary || "内容发生了变化"); }
        break;
      case "video":
        evParts.push(e.video_state && e.video_state.state === "playing"
          ? `检测到视频/动画正在播放${e.video_state.region ? `（区域约在屏幕 ${Math.round(e.video_state.region.fy1 * 100)}%~${Math.round(e.video_state.region.fy2 * 100)}% 高度处）` : ""}`
          : "视频/动画疑似暂停");
        break;
      case "popup":
        evParts.push(`出现${e.summary || "新的界面元素"}`);
        break;
      case "focus":
        evParts.push(`输入焦点${e.summary || "发生了变化"}`);
        break;
      case "motion":
        evParts.push(e.summary || "画面出现变化");
        break;
      default:
        if (e.summary) evParts.push(e.summary);
    }
  }
  if (evParts.length) parts.push(`最近的动态：${evParts.join("；")}。`);

  // 3) 屏面上有什么（可见文本压缩到前几条）
  if (!frame.privacy_masked && frame.visible_text) {
    const short = frame.visible_text.length > 160 ? frame.visible_text.slice(0, 160) + "…" : frame.visible_text;
    parts.push(`屏面可见文本片段：「${short}」`);
  }

  // 4) 注意力在哪
  if (frame.attention_regions && frame.attention_regions.length) {
    parts.push(`建议重点关注：${frame.attention_regions.map((r) => r.note).slice(0, 3).join("、")}。`);
  }

  return parts.join("");
}

/** 单事件的短句（事件流 JSON 里每条也带一句 summary，便于快速扫读）。 */
export function summarizeEvent(e) {
  switch (e.type) {
    case "scroll": {
      const s = e.scroll_event;
      return s ? `滚动（${s.direction === "down" ? "向下" : "向上"}，${s.displacementPx}px，${s.speedPxPerSec}px/s）` : "滚动";
    }
    case "window_switch": return `窗口切换：${pkgName(e.from)} → ${pkgName(e.to)}`;
    case "content_change": return e.added_texts && e.added_texts.length
      ? `内容更新：新增 ${e.added_texts.length} 条、移除 ${e.removed_texts ? e.removed_texts.length : 0} 条可见文本`
      : "内容更新";
    case "video": return e.video_state ? `视频${e.video_state.state === "playing" ? "播放中" : "已暂停"}` : "视频状态变化";
    case "popup": return `弹窗/新元素：${e.summary || ""}`.trim();
    case "focus": return `焦点变化：${e.summary || ""}`.trim();
    case "degraded": return `感知降级：${e.reason || "采集通道不可用"}`;
    case "motion": return e.summary || "画面变化";
    default: return e.summary || e.type;
  }
}
