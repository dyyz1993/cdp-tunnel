# 端口池 vs 直连 Chrome 对比报告

生成时间: 2026-06-20T01:30:40.863Z

| 场景 | 直连 Chrome | 端口池 | 一致 |
|------|:---:|:---:|:---:|
| Network 请求捕获数量 | ✅ | ✅ | ✅ |
| Network 请求 URL 一致 | ["/","/favicon.ico","/style.cs | ["/","/favicon.ico","/style.cs | ✅ |
| Network 响应捕获 | ✅ | ✅ | ✅ |
| Console 事件数量 > 0 | ❌ | ❌ | ✅ |
| Console 消息一致 | [] | [] | ✅ |
| 注入脚本生效 | ✅ | ✅ | ✅ |
| 注入脚本内容一致 | ✅ | ✅ | ✅ |
| 截图有数据 | ✅ | ✅ | ✅ |
| 重连后页面存活 | ✅ | ✅ | ✅ |
| Cookie 设置成功 | ✅ | ✅ | ✅ |
| Cookie 数量一致 | ✅ | ✅ | ✅ |
| localStorage 读写 | "test-value" | "test-value" | ✅ |
| Fetch.requestPaused 拦截 | ✅ | ✅ | ✅ |
| Security.enable（chrome.debugger 限制） | "skip" | "skip" | ✅ |
| Performance.getMetrics | ❌ | ❌ | ✅ |
| Tracing.start/end | ✅ | ✅ | ✅ |
| Browser.close 命令响应 | ✅ | ✅ | ✅ |

**结论**: 端口池与直连 Chrome 行为完全一致
