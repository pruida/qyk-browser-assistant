const state = document.getElementById("state");
chrome.runtime.sendMessage({ type: "QYK_GET_TASK" }).then(({ task }) => {
  state.textContent = task ? `${task.goal || task.instruction || "浏览器任务"}\n当前页面：${task.pageUrl || "等待打开"}\n状态：${task.lastMessage || task.status}\n步骤：${task.steps || 0}` : "暂无浏览器任务";
});
document.getElementById("cancel").onclick = () => chrome.runtime.sendMessage({ type: "QYK_CANCEL_TASK" }).then(() => window.close());
document.getElementById("vision").onclick = () => {
  state.textContent = "正在重新分析当前页面…";
  chrome.runtime.sendMessage({ type: "QYK_RETRY_VISION" }).then(r => {
    state.textContent = r?.ok ? "当前页面已发送给 GPT-6，请回聊天页查看进度。" : `无法分析：${r?.error || "未知错误"}`;
    if (r?.ok) setTimeout(() => window.close(), 900);
  });
};
