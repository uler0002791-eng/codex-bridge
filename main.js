const {
  Plugin,
  Notice,
  PluginSettingTab,
  Setting,
  Modal,
  TextAreaComponent,
  ItemView,
  MarkdownView,
  SuggestModal,
  TFile,
  TFolder,
  setIcon,
  MarkdownRenderer
} = require("obsidian");
const { execFile, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const VIEW_TYPE_CODEX_CHAT = "codex-bridge-chat-view";
const MAX_CHAT_WINDOWS = 3;
const MAX_CHAT_HISTORY = 10;
const MAX_SESSION_MESSAGES = 80;
const MAX_CONTEXT_TEXT = 12000;
const CONTEXT_WINDOW_STANDARD = 200000;
const CONTEXT_WINDOW_1M = 1000000;
const CONTEXT_COMPACT_SOFT_RATIO = 0.8;
const CONTEXT_COMPACT_HARD_RATIO = 0.9;
const CONTEXT_COMPACT_KEEP_RECENT_MESSAGES = 12;
const MAX_COMPACT_SUMMARY_CHARS = 12000;
const MAX_FOLDER_REF_FILES = 15;
const MAX_FOLDER_REF_TOTAL_CHARS = 30000;
const MAX_FOLDER_REF_FILE_CHARS = 3000;
const MAX_SKILLS_PER_SESSION = 8;
const MAX_SKILL_SNIPPET_CHARS = 2400;
const SKILL_CACHE_TTL_MS = 10000;
const LEGACY_MODEL_OPTIONS = "gpt-5,gpt-5-mini,gpt-4.1";
const RECOMMENDED_MODEL_OPTIONS = "gpt-5.2-codex,gpt-5.3-codex,gpt-5.1-codex-max,gpt-5.2,gpt-5.1-codex-mini";

const DEFAULT_SETTINGS = {
  codexCommand: "codex",
  codexArgs: "--full-auto",
  selectedModel: "gpt-5.2-codex",
  modelOptions: RECOMMENDED_MODEL_OPTIONS,
  agentMode: true,
  nativeContextMode: true,
  promptTemplate:
    "你是 Obsidian 写作助手。请根据下面要求处理文本。\\n" +
    "要求：{{instruction}}\\n\\n" +
    "文件：{{file}}\\n\\n" +
    "文本开始\\n{{text}}\\n文本结束\\n\\n" +
    "只输出最终文本，不要解释。",
  applyMode: "replace",
  chatSystemPrompt:
    "你是 Obsidian 中的 AI 助手。默认使用中文回答，直接回答问题，不要只反问用户。若用户提到“这个文档/本文/这篇”，默认指当前打开文档并直接基于文档内容完成任务。",
  includeNoteContextInChat: true,
  sendShortcut: "enter",
  show1MContext: false
};

class InstructionModal extends Modal {
  constructor(app, defaultInstruction) {
    super(app);
    this.defaultInstruction = defaultInstruction;
    this.value = "";
    this.resolver = null;
    this.resolved = false;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Codex 指令" });
    contentEl.createEl("p", {
      text: "输入本次处理要求（例如：润色成简洁中文、保留原有 Markdown 结构）。"
    });

    const input = new TextAreaComponent(contentEl);
    input.setPlaceholder(this.defaultInstruction || "请润色并保持原意");
    input.setValue(this.defaultInstruction || "");
    input.inputEl.rows = 6;
    input.inputEl.style.width = "100%";
    input.inputEl.focus();

    const footer = contentEl.createDiv({ cls: "codex-bridge-modal-footer" });
    const okButton = footer.createEl("button", { text: "执行" });
    const cancelButton = footer.createEl("button", { text: "取消" });

    const submit = () => {
      this.value = input.getValue().trim();
      this.resolveAndClose(this.value);
    };

    okButton.addEventListener("click", submit);
    cancelButton.addEventListener("click", () => {
      this.resolveAndClose(null);
    });

    input.inputEl.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        submit();
      }
    });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
    if (!this.resolved && this.resolver) {
      this.resolver(null);
      this.resolved = true;
    }
  }

  waitForResult() {
    return new Promise((resolve) => {
      this.resolved = false;
      this.resolver = resolve;
      this.open();
    });
  }

  resolveAndClose(value) {
    if (this.resolved) {
      return;
    }
    this.resolved = true;
    if (this.resolver) {
      this.resolver(value);
    }
    this.close();
  }
}

class VaultFileSuggestModal extends SuggestModal {
  constructor(app, onChoose) {
    super(app);
    this.onChoose = onChoose;
    this.files = app.vault.getMarkdownFiles();
    this.setPlaceholder("搜索并选择要 @ 引用的文档");
  }

  getSuggestions(query) {
    const q = (query || "").trim().toLowerCase();
    if (!q) {
      return this.files.slice(0, 80);
    }
    return this.files
      .filter((f) => f.path.toLowerCase().includes(q) || f.basename.toLowerCase().includes(q))
      .slice(0, 80);
  }

  renderSuggestion(file, el) {
    el.createEl("div", { text: file.basename, cls: "codex-bridge-suggest-title" });
    el.createEl("small", { text: file.path, cls: "codex-bridge-suggest-path" });
  }

  onChooseSuggestion(file) {
    if (this.onChoose) {
      this.onChoose(file);
    }
  }
}

class CodexChatView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.messagesEl = null;
    this.inputEl = null;
    this.inputFrameEl = null;
    this.sendButton = null;
    this.isBusy = false;
    this.sessionListEl = null;
    this.currentNoteEl = null;
    this.sessionMetaEl = null;
    this.historyMenuEl = null;
    this.historyMenuOpen = false;
    this.moreMenuEl = null;
    this.moreMenuOpen = false;
    this.mentionMenuEl = null;
    this.contextChipsEl = null;
    this.mentionChipsEl = null;
    this.mentionQuickBtn = null;
    this.skillQuickBtn = null;
    this.skillChipsEl = null;
    this.skillMenuEl = null;
    this.skillMenuOpen = false;
    this.skillMenuTriggerBySlash = false;
    this.skillCommandRange = null;
    this.skillActiveIndex = 0;
    this.skillVisibleItems = [];
    this.skillSearchInputEl = null;
    this.skillQuery = "";
    this.availableSkills = [];
    this.mentionSuggestions = [];
    this.mentionActiveIndex = 0;
    this.mentionRange = null;
    this.selectedMentions = [];
    this.selectedSkills = [];
    this.selectionMetaEl = null;
    this.selectionMetaTextEl = null;
    this.selectionMetaClearBtn = null;
    this.modelRowEl = null;
    this.modelSelectEl = null;
    this.modeRowEl = null;
    this.modeToggleEl = null;
    this.modeLabelEl = null;
    this.inputActionBtn = null;
    this.imageBtn = null;
    this.imagePickerEl = null;
    this.imagePreviewEl = null;
    this.selectedImages = [];
    this.contextMeterBtn = null;
    this.contextMeterTextEl = null;
    this.contextMeterState = null;
    this.selectionTicker = null;
    this.isImeComposing = false;
    this.lastCompositionEndAt = 0;
  }

  getViewType() {
    return VIEW_TYPE_CODEX_CHAT;
  }

  getDisplayText() {
    return "Codex Chat";
  }

  getIcon() {
    return "bot";
  }

  async onOpen() {
    this.render();
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        this.plugin.captureMarkdownContextFromLeaf(leaf);
        this.updateCurrentNoteLabel();
        this.loadDraftMentionsFromSession();
        this.ensureAutoDocMentionForSession();
        this.renderMentionChips();
        this.updateSelectionLabel();
      })
    );
    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        this.updateCurrentNoteLabel();
        this.loadDraftMentionsFromSession();
        this.ensureAutoDocMentionForSession();
        this.renderMentionChips();
      })
    );
    this.selectionTicker = window.setInterval(() => {
      this.updateSelectionLabel();
    }, 350);
    this.loadAvailableSkills().catch(() => {});
  }

  async onClose() {
    this.clearImageAttachments();
    if (this.selectionTicker) {
      window.clearInterval(this.selectionTicker);
      this.selectionTicker = null;
    }
  }

  render() {
    const root = this.contentEl;
    root.empty();

    const wrapper = root.createDiv({ cls: "codex-bridge-chat-root" });

    const header = wrapper.createDiv({ cls: "codex-bridge-chat-header" });
    const titleWrap = header.createDiv({ cls: "codex-bridge-title-wrap" });
    const logo = titleWrap.createDiv({ cls: "codex-bridge-logo" });
    safeSetIcon(logo, "bot", "AI");
    titleWrap.createEl("div", { cls: "codex-bridge-chat-title", text: "Codex Bridge" });

    const metaRow = wrapper.createDiv({ cls: "codex-bridge-meta-row" });
    this.currentNoteEl = metaRow.createDiv({ cls: "codex-bridge-current-note" });
    this.sessionMetaEl = metaRow.createDiv({ cls: "codex-bridge-session-meta" });

    this.messagesEl = wrapper.createDiv({ cls: "codex-bridge-chat-messages" });

    const dock = wrapper.createDiv({ cls: "codex-bridge-chat-dock" });
    this.sessionListEl = dock.createDiv({ cls: "codex-bridge-session-strip" });
    const dockActions = dock.createDiv({ cls: "codex-bridge-dock-actions" });

    const newChatBtn = dockActions.createEl("button", {
      cls: "codex-bridge-action-btn"
    });
    safeSetIcon(newChatBtn, "message-circle-plus", "+");
    newChatBtn.title = "新对话";
    newChatBtn.addEventListener("click", async () => {
      await this.plugin.createNewSession();
      this.historyMenuOpen = false;
      this.moreMenuOpen = false;
      this.refresh();
    });

    const settingsBtn = dockActions.createEl("button", {
      cls: "codex-bridge-action-btn"
    });
    safeSetIcon(settingsBtn, "settings", "S");
    settingsBtn.title = "插件设置";
    settingsBtn.addEventListener("click", async () => {
      try {
        if (this.app.setting && typeof this.app.setting.open === "function") {
          this.app.setting.open();
          if (typeof this.app.setting.openTabById === "function" && this.plugin.manifest && this.plugin.manifest.id) {
            this.app.setting.openTabById(this.plugin.manifest.id);
          }
        }
      } catch (error) {
      }
    });

    const historyBtn = dockActions.createEl("button", {
      cls: "codex-bridge-action-btn"
    });
    safeSetIcon(historyBtn, "history", "H");
    historyBtn.title = "会话历史";
    historyBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.historyMenuOpen = !this.historyMenuOpen;
      this.moreMenuOpen = false;
      this.renderHistoryMenu();
      this.renderMoreMenu();
    });
    const moreWrap = dockActions.createDiv({ cls: "codex-bridge-more-wrap" });
    const moreBtn = moreWrap.createEl("button", {
      cls: "codex-bridge-action-btn"
    });
    safeSetIcon(moreBtn, "ellipsis", "...");
    moreBtn.title = "更多";
    moreBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.moreMenuOpen = !this.moreMenuOpen;
      this.historyMenuOpen = false;
      this.renderMoreMenu();
      this.renderHistoryMenu();
    });
    this.historyMenuEl = dock.createDiv({ cls: "codex-bridge-history-menu" });
    this.moreMenuEl = moreWrap.createDiv({ cls: "codex-bridge-more-menu" });
    this.contextMeterBtn = dockActions.createEl("button", { cls: "codex-bridge-context-meter" });
    this.contextMeterBtn.type = "button";
    this.contextMeterBtn.title = "Context usage";
    this.contextMeterBtn.setAttr("aria-label", "Context usage");
    this.contextMeterTextEl = this.contextMeterBtn.createDiv({ cls: "codex-bridge-context-meter-text", text: "0%" });
    this.contextMeterBtn.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const session = this.plugin.getActiveSession();
      if (!session || this.isBusy) {
        return;
      }
      this.contextMeterBtn.addClass("is-working");
      try {
        const compacted = await this.plugin.compactSessionContext(session, "manual");
        if (compacted && compacted.performed) {
          new Notice("已压缩会话上下文");
          this.refresh();
        } else {
          new Notice("当前上下文占用较低，无需压缩");
        }
      } catch (error) {
        new Notice("上下文压缩失败");
      } finally {
        this.contextMeterBtn.removeClass("is-working");
        this.updateContextMeter();
      }
    });
    this.registerDomEvent(dock, "click", (event) => event.stopPropagation());
    this.registerDomEvent(moreWrap, "click", (event) => event.stopPropagation());
    this.registerDomEvent(document, "click", () => {
      let changed = false;
      if (this.historyMenuOpen) {
        this.historyMenuOpen = false;
        changed = true;
      }
      if (this.moreMenuOpen) {
        this.moreMenuOpen = false;
        changed = true;
      }
      if (changed) {
        this.renderHistoryMenu();
        this.renderMoreMenu();
      }
    });
    const composer = wrapper.createDiv({ cls: "codex-bridge-chat-composer" });
    this.mentionMenuEl = composer.createDiv({ cls: "codex-bridge-mention-menu" });
    this.skillMenuEl = composer.createDiv({ cls: "codex-bridge-skill-menu" });
    this.inputFrameEl = composer.createDiv({ cls: "codex-bridge-input-frame" });
    this.contextChipsEl = this.inputFrameEl.createDiv({ cls: "codex-bridge-context-chips" });
    this.mentionQuickBtn = this.contextChipsEl.createEl("button", {
      cls: "codex-bridge-mention-quick-btn",
      text: "@"
    });
    this.mentionQuickBtn.type = "button";
    this.mentionQuickBtn.title = "添加引用";
    this.mentionQuickBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.triggerMentionPicker();
    });
    this.skillQuickBtn = this.contextChipsEl.createEl("button", {
      cls: "codex-bridge-skill-quick-btn",
      text: "Skills"
    });
    this.skillQuickBtn.type = "button";
    this.skillQuickBtn.title = "选择技能";
    this.skillQuickBtn.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (this.skillMenuOpen) {
        this.hideSkillMenu();
      } else {
        this.skillMenuTriggerBySlash = false;
        this.skillCommandRange = null;
        this.skillActiveIndex = 0;
        this.skillQuery = "";
        await this.loadAvailableSkills();
        this.skillMenuOpen = true;
        this.renderSkillMenu();
      }
    });
    this.mentionChipsEl = this.contextChipsEl.createDiv({ cls: "codex-bridge-mention-chips" });
    this.skillChipsEl = this.contextChipsEl.createDiv({ cls: "codex-bridge-skill-chips" });
    this.selectionMetaEl = this.contextChipsEl.createDiv({ cls: "codex-bridge-selection-meta" });
    this.selectionMetaTextEl = this.selectionMetaEl.createSpan({ cls: "codex-bridge-selection-meta-text" });
    this.selectionMetaClearBtn = this.selectionMetaEl.createEl("button", {
      cls: "codex-bridge-selection-meta-clear",
      text: "×"
    });
    this.selectionMetaClearBtn.type = "button";
    this.selectionMetaClearBtn.title = "取消选中上下文";
    this.selectionMetaClearBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.plugin.clearActiveSelectionContext();
      this.updateSelectionLabel();
      this.inputEl?.focus();
    });
    this.inputEl = this.inputFrameEl.createEl("textarea", { cls: "codex-bridge-chat-input" });
    this.updateInputPlaceholder();
    this.inputEl.rows = 4;
    this.imagePreviewEl = this.inputFrameEl.createDiv({ cls: "codex-bridge-image-preview-wrap" });
    this.imagePickerEl = this.inputFrameEl.createEl("input", { cls: "codex-bridge-image-picker" });
    this.imagePickerEl.type = "file";
    this.imagePickerEl.accept = "image/*";
    this.imagePickerEl.multiple = true;
    this.imagePickerEl.addEventListener("change", async () => {
      const files = this.imagePickerEl && this.imagePickerEl.files ? Array.from(this.imagePickerEl.files) : [];
      await this.addImageFiles(files);
      if (this.imagePickerEl) {
        this.imagePickerEl.value = "";
      }
    });

    this.modelRowEl = this.inputFrameEl.createDiv({ cls: "codex-bridge-model-row" });
    this.modelSelectEl = this.modelRowEl.createEl("select", { cls: "codex-bridge-model-select" });
    this.modelSelectEl.addEventListener("change", async () => {
      if (!this.modelSelectEl) {
        return;
      }
      await this.plugin.setSelectedModel(this.modelSelectEl.value);
      this.renderModelSelect();
    });

    this.modeRowEl = this.inputFrameEl.createDiv({ cls: "codex-bridge-mode-row" });
    this.modeLabelEl = this.modeRowEl.createSpan({ cls: "codex-bridge-mode-label" });
    this.modeToggleEl = this.modeRowEl.createEl("button", { cls: "codex-bridge-mode-toggle" });
    this.modeToggleEl.type = "button";
    this.modeToggleEl.addEventListener("click", async () => {
      const next = !this.plugin.isAgentMode();
      await this.plugin.setAgentMode(next, this.plugin.getActiveSession());
      this.renderModeToggle();
      new Notice(next ? "已切换到 Agent 模式" : "已切换到 Ask 模式");
    });
    this.imageBtn = this.inputFrameEl.createEl("button", { cls: "codex-bridge-image-btn" });
    this.imageBtn.type = "button";
    this.imageBtn.title = "添加图片";
    safeSetIcon(this.imageBtn, "image-plus", "🖼");
    this.imageBtn.addEventListener("click", () => {
      this.imagePickerEl?.click();
    });
    this.inputActionBtn = this.inputFrameEl.createEl("button", { cls: "codex-bridge-input-action-btn" });
    this.inputActionBtn.type = "button";
    this.inputActionBtn.addEventListener("click", () => {
      if (this.isBusy) {
        const ok = this.plugin.interruptActiveRun();
        if (ok) {
          new Notice("已请求中断");
        }
      } else {
        this.sendMessage();
      }
    });

    this.inputEl.addEventListener("compositionstart", () => {
      this.isImeComposing = true;
    });
    this.inputEl.addEventListener("compositionend", () => {
      this.isImeComposing = false;
      this.lastCompositionEndAt = Date.now();
    });

    this.inputEl.addEventListener("keydown", (event) => {
      if (this.handleSkillMenuKeydown(event)) {
        return;
      }
      if (this.handleMentionKeydown(event)) {
        return;
      }
      if (event.key !== "Enter") {
        return;
      }
      const now = Date.now();
      const justEndedComposition = now - (this.lastCompositionEndAt || 0) < 140;
      const imeComposing =
        this.isImeComposing ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.key === "Process" ||
        justEndedComposition;
      if (imeComposing) {
        return;
      }

      const mode = this.plugin.getSendShortcutMode();
      const wantSend =
        mode === "enter"
          ? !event.shiftKey
          : (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey;
      if (wantSend) {
        event.preventDefault();
        this.sendMessage();
      }
    });
    this.inputEl.addEventListener("input", () => {
      this.updateMentionSuggestions();
      this.updateSkillSuggestionsFromInput();
      this.updateInputActionButton();
    });
    this.inputEl.addEventListener("click", () => {
      this.updateMentionSuggestions();
      this.updateSkillSuggestionsFromInput();
      this.updateInputActionButton();
    });
    this.inputEl.addEventListener("keyup", () => {
      this.updateMentionSuggestions();
      this.updateSkillSuggestionsFromInput();
      this.updateInputActionButton();
    });
    this.inputEl.addEventListener("paste", async (event) => {
      const clipboard = event && event.clipboardData ? event.clipboardData : null;
      if (!clipboard || !clipboard.items || !clipboard.items.length) {
        return;
      }
      const files = [];
      for (const item of Array.from(clipboard.items)) {
        if (item && typeof item.type === "string" && item.type.startsWith("image/")) {
          const f = item.getAsFile();
          if (f) {
            files.push(f);
          }
        }
      }
      if (!files.length) {
        return;
      }
      event.preventDefault();
      await this.addImageFiles(files);
    });
    this.registerDomEvent(this.inputEl, "blur", () => {
      window.setTimeout(() => this.hideMentionSuggestions(), 100);
    });
    this.registerDomEvent(composer, "click", (event) => event.stopPropagation());
    this.registerDomEvent(document, "click", () => {
      this.hideMentionSuggestions();
      this.hideSkillMenu();
    });

    this.refresh();
  }

  refresh() {
    this.updateCurrentNoteLabel();
    this.renderSessionList();
    this.renderHistoryMenu();
    this.renderMoreMenu();
    this.renderMessages();
    this.loadDraftMentionsFromSession();
    this.loadDraftSkillsFromSession();
    this.ensureAutoDocMentionForSession();
    this.renderMentionChips();
    this.renderSkillChips();
    this.updateSelectionLabel();
    this.renderModelSelect();
    this.renderModeToggle();
    this.updateInputPlaceholder();
    this.updateInputActionButton();
    this.updateContextMeter();
    this.renderImagePreviews();
    this.hideMentionSuggestions();
    this.updateInputOverlayLayout();
  }

  loadDraftMentionsFromSession() {
    const session = this.plugin.getActiveSession();
    if (!session) {
      this.selectedMentions = [];
      return;
    }
    this.selectedMentions = normalizeMentionEntries(session.draftMentions || []);
  }

  loadDraftSkillsFromSession() {
    const session = this.plugin.getActiveSession();
    if (!session) {
      this.selectedSkills = [];
      return;
    }
    this.selectedSkills = normalizeSkillIds(session.draftSkills || []);
  }

  saveDraftMentionsToSession() {
    const session = this.plugin.getActiveSession();
    if (!session) {
      return;
    }
    session.draftMentions = normalizeMentionEntries(this.selectedMentions || []);
    session.updatedAt = Date.now();
    this.plugin.persist().catch(() => {});
  }

  saveDraftSkillsToSession() {
    const session = this.plugin.getActiveSession();
    if (!session) {
      return;
    }
    session.draftSkills = normalizeSkillIds(this.selectedSkills || []);
    session.updatedAt = Date.now();
    this.plugin.persist().catch(() => {});
  }

  ensureAutoDocMentionForSession() {
    const session = this.plugin.getActiveSession();
    if (!session) {
      return;
    }
    if (session.autoDocMentionDisabled) {
      return;
    }
    if (Array.isArray(this.selectedMentions) && this.selectedMentions.length > 0) {
      return;
    }
    if (Array.isArray(session.messages) && session.messages.length > 0) {
      return;
    }

    const note = this.plugin.getActiveNoteContext();
    if (!note.path) {
      return;
    }
    const file = this.plugin.getMarkdownFileByLoosePath(note.path);
    if (!file) {
      return;
    }

    this.selectedMentions = [
      {
        type: "file",
        path: file.path,
        name: file.basename || file.name || file.path,
        auto: true
      }
    ];
    session.autoDocMentionSeeded = true;
    session.draftMentions = normalizeMentionEntries(this.selectedMentions);
    session.updatedAt = Date.now();
    this.plugin.persist().catch(() => {});
  }

  renderModelSelect() {
    if (!this.modelSelectEl) {
      return;
    }
    const models = this.plugin.getModelOptions();
    const selected = this.plugin.getSelectedModel();
    this.modelSelectEl.empty();
    for (const model of models) {
      const option = this.modelSelectEl.createEl("option", { text: model });
      option.value = model;
    }
    if (!models.includes(selected)) {
      const option = this.modelSelectEl.createEl("option", { text: selected });
      option.value = selected;
    }
    this.modelSelectEl.value = selected;
  }

  renderModeToggle() {
    if (!this.modeToggleEl || !this.modeLabelEl) {
      return;
    }
    const enabled = this.plugin.isAgentMode();
    this.modeToggleEl.toggleClass("is-on", enabled);
    this.modeToggleEl.setAttr("aria-pressed", enabled ? "true" : "false");
    this.modeLabelEl.setText(enabled ? "AGENT" : "ASK");
  }

  updateInputActionButton() {
    if (!this.inputActionBtn) {
      return;
    }
    if (this.isBusy) {
      this.inputActionBtn.removeClass("is-send");
      this.inputActionBtn.addClass("is-stop");
      safeSetIcon(this.inputActionBtn, "square", "■");
      this.inputActionBtn.title = "中断生成";
      this.inputActionBtn.removeAttribute("disabled");
      return;
    }
    this.inputActionBtn.removeClass("is-stop");
    this.inputActionBtn.addClass("is-send");
    safeSetIcon(this.inputActionBtn, "send-horizontal", ">");
    this.inputActionBtn.title = "发送";
    const hasText = !!String(this.inputEl && this.inputEl.value ? this.inputEl.value : "").trim();
    const hasImages = Array.isArray(this.selectedImages) && this.selectedImages.length > 0;
    if (hasText || hasImages) {
      this.inputActionBtn.removeAttribute("disabled");
    } else {
      this.inputActionBtn.setAttribute("disabled", "true");
    }
    this.updateContextMeter();
  }

  updateContextMeter() {
    if (!this.contextMeterBtn) {
      return;
    }
    const session = this.plugin.getActiveSession();
    const usage = this.plugin.estimateContextUsage(session, {
      draftInput: this.inputEl && this.inputEl.value ? this.inputEl.value : "",
      mentions: this.selectedMentions,
      skills: this.selectedSkills,
      imageCount: Array.isArray(this.selectedImages) ? this.selectedImages.length : 0
    });
    this.contextMeterState = usage;
    const pct = Math.max(0, Math.min(100, Math.round(usage.ratio * 100)));
    if (this.contextMeterTextEl) {
      this.contextMeterTextEl.setText(`${pct}%`);
    }
    const color =
      usage.ratio >= CONTEXT_COMPACT_HARD_RATIO
        ? "#ff8f6c"
        : usage.ratio >= CONTEXT_COMPACT_SOFT_RATIO
          ? "#f0b45e"
          : "#8a8f97";
    this.contextMeterBtn.style.setProperty("--codex-context-ratio", `${pct}%`);
    this.contextMeterBtn.style.setProperty("--codex-context-color", color);
    this.contextMeterBtn.toggleClass("is-soft", usage.ratio >= CONTEXT_COMPACT_SOFT_RATIO);
    this.contextMeterBtn.toggleClass("is-hard", usage.ratio >= CONTEXT_COMPACT_HARD_RATIO);
    this.contextMeterBtn.title =
      `Context window: ${pct}% full\n` +
      `${usage.used.toLocaleString()} / ${usage.max.toLocaleString()} tokens used\n` +
      `会在 >=${Math.round(CONTEXT_COMPACT_SOFT_RATIO * 100)}% 自动压缩，>=${Math.round(
        CONTEXT_COMPACT_HARD_RATIO * 100
      )}% 强制压缩`;
  }

  async addImageFiles(files) {
    if (!Array.isArray(files) || !files.length) {
      return;
    }
    for (const file of files) {
      if (!file) {
        continue;
      }
      let imagePath = typeof file.path === "string" ? file.path : "";
      const name = file.name || path.basename(imagePath || "") || `image-${Date.now()}.png`;
      if (!imagePath) {
        try {
          const ab = await file.arrayBuffer();
          const ext = (file.type && file.type.split("/")[1]) || "png";
          imagePath = path.join(
            os.tmpdir(),
            `codex-bridge-paste-${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`
          );
          fs.writeFileSync(imagePath, Buffer.from(ab));
        } catch (error) {
          continue;
        }
      }
      if (!imagePath || !fs.existsSync(imagePath)) {
        continue;
      }
      if (this.selectedImages.some((img) => img.path === imagePath)) {
        continue;
      }
      let previewUrl = "";
      try {
        previewUrl = URL.createObjectURL(file);
      } catch (error) {
        previewUrl = "";
      }
      this.selectedImages.push({
        id: newId(),
        path: imagePath,
        name,
        previewUrl
      });
    }
    this.renderImagePreviews();
    this.updateInputActionButton();
  }

  removeImageAttachment(id) {
    const hit = this.selectedImages.find((img) => img.id === id);
    this.selectedImages = this.selectedImages.filter((img) => img.id !== id);
    if (hit && hit.previewUrl) {
      try {
        URL.revokeObjectURL(hit.previewUrl);
      } catch (error) {
      }
    }
    this.renderImagePreviews();
    this.updateInputActionButton();
  }

  clearImageAttachments() {
    for (const img of this.selectedImages) {
      if (img && img.previewUrl) {
        try {
          URL.revokeObjectURL(img.previewUrl);
        } catch (error) {
        }
      }
    }
    this.selectedImages = [];
    this.renderImagePreviews();
    this.updateInputActionButton();
  }

  renderImagePreviews() {
    if (!this.imagePreviewEl) {
      return;
    }
    this.imagePreviewEl.empty();
    if (!this.selectedImages.length) {
      this.imagePreviewEl.removeClass("is-visible");
      this.inputFrameEl?.removeClass("has-image-preview");
      this.updateInputOverlayLayout();
      return;
    }
    this.imagePreviewEl.addClass("is-visible");
    this.inputFrameEl?.addClass("has-image-preview");
    for (const img of this.selectedImages) {
      const card = this.imagePreviewEl.createDiv({ cls: "codex-bridge-image-card" });
      const imageEl = card.createEl("img", { cls: "codex-bridge-image-thumb" });
      imageEl.src = img.previewUrl || `file://${img.path}`;
      imageEl.alt = img.name || "image";
      const removeBtn = card.createEl("button", {
        cls: "codex-bridge-image-remove",
        text: "×"
      });
      removeBtn.type = "button";
      removeBtn.title = "删除图片";
      removeBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.removeImageAttachment(img.id);
      });
    }
    this.updateInputOverlayLayout();
  }

  updateSelectionLabel() {
    if (!this.selectionMetaEl) {
      return;
    }
    const selection = this.plugin.getActiveSelectionContext();
    if (selection && selection.lineCount > 0 && selection.text && selection.text.trim()) {
      if (this.selectionMetaTextEl) {
        this.selectionMetaTextEl.setText(`${selection.lineCount} lines selected`);
      }
      this.selectionMetaEl.addClass("is-visible");
      this.syncContextChipsVisible();
    } else {
      if (this.selectionMetaTextEl) {
        this.selectionMetaTextEl.setText("");
      }
      this.selectionMetaEl.removeClass("is-visible");
      this.syncContextChipsVisible();
    }
    this.updateContextMeter();
  }

  syncContextChipsVisible() {
    if (!this.contextChipsEl) {
      return;
    }
    this.contextChipsEl.addClass("is-visible");
    window.requestAnimationFrame(() => this.updateInputOverlayLayout());
  }

  updateInputOverlayLayout() {
    if (!this.inputFrameEl || !this.contextChipsEl) {
      return;
    }
    const rawHeight = this.contextChipsEl.getBoundingClientRect().height;
    const chipsHeight = Number.isFinite(rawHeight) ? Math.max(26, Math.ceil(rawHeight)) : 26;
    this.inputFrameEl.style.setProperty("--codex-mention-area-height", `${chipsHeight}px`);
  }

  updateInputPlaceholder() {
    if (!this.inputEl) {
      return;
    }
    const mode = this.plugin.getSendShortcutMode();
    this.inputEl.placeholder =
      mode === "enter"
        ? "输入消息，Enter 发送，Shift+Enter 换行。支持 @[[文档或文件夹路径]]、/skill"
        : "输入消息，Cmd/Ctrl+Enter 发送，Enter 换行。支持 @[[文档或文件夹路径]]、/skill";
  }

  triggerMentionPicker() {
    if (!this.inputEl) {
      return;
    }
    const value = this.inputEl.value || "";
    const start = Number.isFinite(this.inputEl.selectionStart) ? this.inputEl.selectionStart : value.length;
    const end = Number.isFinite(this.inputEl.selectionEnd) ? this.inputEl.selectionEnd : start;
    const left = value.slice(0, start);
    const right = value.slice(end);
    const needSpace = left.length > 0 && !/\s$/.test(left);
    const insert = needSpace ? " @" : "@";
    this.inputEl.value = `${left}${insert}${right}`;
    const cursor = left.length + insert.length;
    this.inputEl.focus();
    this.inputEl.setSelectionRange(cursor, cursor);
    this.updateMentionSuggestions();
    this.updateInputActionButton();
  }

  handleMentionKeydown(event) {
    if (!this.mentionMenuEl || !this.mentionSuggestions.length) {
      return false;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      this.mentionActiveIndex = Math.min(this.mentionActiveIndex + 1, this.mentionSuggestions.length - 1);
      this.renderMentionSuggestions();
      return true;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      this.mentionActiveIndex = Math.max(this.mentionActiveIndex - 1, 0);
      this.renderMentionSuggestions();
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      const ref = this.mentionSuggestions[this.mentionActiveIndex];
      if (ref) {
        this.applyMention(ref);
      }
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      this.hideMentionSuggestions();
      return true;
    }
    return false;
  }

  handleSkillMenuKeydown(event) {
    if (!this.skillMenuOpen) {
      return false;
    }
    const imeComposing =
      this.isImeComposing || event.isComposing || event.keyCode === 229 || event.key === "Process";
    if (imeComposing) {
      return false;
    }
    const items = Array.isArray(this.skillVisibleItems) ? this.skillVisibleItems : [];
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (items.length) {
        this.skillActiveIndex = (this.skillActiveIndex + 1 + items.length) % items.length;
        this.renderSkillMenu();
      }
      return true;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (items.length) {
        this.skillActiveIndex = (this.skillActiveIndex - 1 + items.length) % items.length;
        this.renderSkillMenu();
      }
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      this.hideSkillMenu();
      return true;
    }
    if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
      event.preventDefault();
      const pick = items[this.skillActiveIndex];
      if (pick) {
        this.toggleSkillFromMenu(pick);
      }
      return true;
    }
    return false;
  }

  updateSkillSuggestionsFromInput() {
    if (!this.inputEl || !this.skillMenuEl) {
      return;
    }
    const value = this.inputEl.value || "";
    const cursor = Number.isFinite(this.inputEl.selectionStart) ? this.inputEl.selectionStart : value.length;
    const head = value.slice(0, cursor);
    const match = head.match(/(^|\s)\/skill(?:\s+([^\n\r]*))?$/i);
    if (!match) {
      if (this.skillMenuTriggerBySlash) {
        this.hideSkillMenu();
      }
      return;
    }
    const prefix = match[1] || "";
    const query = (match[2] || "").trim();
    const prevQuery = this.skillQuery || "";
    const wasSlashMode = this.skillMenuTriggerBySlash;
    const cmdLen = match[0].length;
    const start = Math.max(0, cursor - cmdLen + prefix.length);
    this.skillMenuTriggerBySlash = true;
    this.skillCommandRange = { start, end: cursor };
    this.skillQuery = query;
    if (!wasSlashMode || query !== prevQuery) {
      this.skillActiveIndex = 0;
    }
    if (!this.skillMenuOpen) {
      this.skillMenuOpen = true;
    }
    this.loadAvailableSkills().catch(() => {});
    this.renderSkillMenu();
  }

  consumeSlashSkillCommand() {
    if (!this.inputEl || !this.skillCommandRange) {
      return;
    }
    const value = this.inputEl.value || "";
    const { start, end } = this.skillCommandRange;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
      return;
    }
    let left = value.slice(0, start);
    let right = value.slice(end);
    if (/\s$/.test(left) && /^\s/.test(right)) {
      right = right.replace(/^\s+/, " ");
    }
    this.inputEl.value = `${left}${right}`;
    const cursor = Math.min(this.inputEl.value.length, left.length);
    this.inputEl.setSelectionRange(cursor, cursor);
    this.hideSkillMenu();
    this.updateInputActionButton();
  }

  updateMentionSuggestions() {
    if (!this.inputEl || !this.mentionMenuEl) {
      return;
    }
    const value = this.inputEl.value || "";
    const cursor = this.inputEl.selectionStart || 0;
    const head = value.slice(0, cursor);
    const atIndex = head.lastIndexOf("@");
    if (atIndex < 0) {
      this.hideMentionSuggestions();
      return;
    }
    const beforeAt = atIndex > 0 ? head[atIndex - 1] : "";
    if (beforeAt && !/\s|[(\[{'"`]/.test(beforeAt)) {
      this.hideMentionSuggestions();
      return;
    }
    const rawToken = head.slice(atIndex + 1);
    if (/[\s\n\r]/.test(rawToken)) {
      this.hideMentionSuggestions();
      return;
    }
    const query = rawToken.startsWith("[[") ? rawToken.slice(2) : rawToken;
    const q = query.toLowerCase();
    const fileRefs = this.app.vault
      .getMarkdownFiles()
      .map((f) => ({
        type: "file",
        path: f.path,
        name: f.basename || f.name || f.path
      }));
    const folderRefs = this.app.vault
      .getAllLoadedFiles()
      .filter((f) => f instanceof TFolder && f.path)
      .map((f) => ({
        type: "folder",
        path: f.path,
        name: f.name || f.path
      }));
    const byPath = (a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: "base" });
    let refs = [];
    if (!q) {
      refs = [
        ...fileRefs.sort(byPath).slice(0, 10),
        ...folderRefs.sort(byPath).slice(0, 10)
      ];
    } else {
      const folderHint = q.endsWith("/") || q.includes("folder") || q.includes("文件夹");
      const score = (ref) => {
        const p = String(ref.path || "").toLowerCase();
        const n = String(ref.name || "").toLowerCase();
        let s = 0;
        if (n === q || p === q || p === `${q}.md` || `${p}/` === q) {
          s += 120;
        }
        if (n.startsWith(q) || p.startsWith(q)) {
          s += 80;
        }
        if (n.includes(q)) {
          s += 35;
        }
        if (p.includes(q)) {
          s += 25;
        }
        if (folderHint && ref.type === "folder") {
          s += 40;
        }
        return s;
      };
      refs = [...fileRefs, ...folderRefs]
        .filter((f) => {
          const p = String(f.path || "").toLowerCase();
          const n = String(f.name || "").toLowerCase();
          return p.includes(q) || n.includes(q);
        })
        .sort((a, b) => {
          const scoreDiff = score(b) - score(a);
          if (scoreDiff !== 0) {
            return scoreDiff;
          }
          if (a.type !== b.type) {
            return a.type === "folder" ? -1 : 1;
          }
          return byPath(a, b);
        })
        .slice(0, 24);
    }
    if (!refs.length) {
      this.hideMentionSuggestions();
      return;
    }
    this.mentionRange = { start: atIndex, end: cursor };
    this.mentionSuggestions = refs;
    this.mentionActiveIndex = Math.min(this.mentionActiveIndex, refs.length - 1);
    this.renderMentionSuggestions();
  }

  renderMentionSuggestions() {
    if (!this.mentionMenuEl) {
      return;
    }
    this.mentionMenuEl.empty();
    if (!this.mentionSuggestions.length) {
      this.mentionMenuEl.removeClass("is-open");
      return;
    }
    this.mentionMenuEl.addClass("is-open");
    for (let i = 0; i < this.mentionSuggestions.length; i += 1) {
      const ref = this.mentionSuggestions[i];
      const row = this.mentionMenuEl.createEl("button", {
        cls: `codex-bridge-mention-item ${i === this.mentionActiveIndex ? "is-active" : ""}`
      });
      row.type = "button";
      const iconEl = row.createDiv({ cls: "codex-bridge-mention-icon" });
      safeSetIcon(iconEl, ref.type === "folder" ? "folder" : "file-text", ref.type === "folder" ? "D" : "F");
      row.createDiv({
        cls: "codex-bridge-mention-path",
        text: ref.type === "folder" ? `${ref.path}/` : ref.path
      });
      row.addEventListener("mousedown", (event) => {
        event.preventDefault();
        this.applyMention(ref);
      });
    }
  }

  hideMentionSuggestions() {
    if (!this.mentionMenuEl) {
      return;
    }
    this.mentionSuggestions = [];
    this.mentionRange = null;
    this.mentionMenuEl.empty();
    this.mentionMenuEl.removeClass("is-open");
  }

  applyMention(ref) {
    if (!this.inputEl || !ref) {
      return;
    }
    if (this.mentionRange) {
      const value = this.inputEl.value || "";
      const { start, end } = this.mentionRange;
      this.inputEl.value = `${value.slice(0, start)}${value.slice(end)}`;
      this.inputEl.setSelectionRange(start, start);
    }
    this.addMentionReference(ref);
    this.inputEl.focus();
    this.hideMentionSuggestions();
  }

  addMentionReference(rawRef) {
    const ref = normalizeMentionEntry(rawRef);
    if (!ref || !ref.path) {
      return;
    }
    if (this.selectedMentions.some((m) => m.path === ref.path && m.type === ref.type)) {
      this.renderMentionChips();
      return;
    }
    const clean = Object.assign({}, ref, { auto: false });
    this.selectedMentions.push(clean);
    this.saveDraftMentionsToSession();
    this.renderMentionChips();
  }

  removeMentionReference(rawRef) {
    const ref = normalizeMentionEntry(rawRef);
    if (!ref) {
      return;
    }
    const removed = this.selectedMentions.find((m) => m.path === ref.path && m.type === ref.type);
    this.selectedMentions = this.selectedMentions.filter((m) => !(m.path === ref.path && m.type === ref.type));
    const session = this.plugin.getActiveSession();
    if (removed && removed.auto && session) {
      session.autoDocMentionDisabled = true;
    }
    this.saveDraftMentionsToSession();
    this.renderMentionChips();
  }

  renderMentionChips() {
    if (!this.mentionChipsEl) {
      return;
    }
    this.mentionChipsEl.empty();
    if (!this.selectedMentions.length) {
      this.mentionChipsEl.removeClass("is-visible");
      this.syncContextChipsVisible();
      this.updateContextMeter();
      return;
    }
    this.mentionChipsEl.addClass("is-visible");
    for (const mention of this.selectedMentions) {
      const chip = this.mentionChipsEl.createDiv({ cls: "codex-bridge-mention-chip" });
      const iconEl = chip.createDiv({ cls: "codex-bridge-mention-chip-icon" });
      safeSetIcon(iconEl, mention.type === "folder" ? "folder" : "file-text", mention.type === "folder" ? "D" : "F");
      chip.createDiv({
        cls: "codex-bridge-mention-chip-name",
        text: mention.name || mention.path
      });
      if (mention.auto) {
        chip.createDiv({
          cls: "codex-bridge-mention-chip-tag",
          text: "Current"
        });
      }
      const removeBtn = chip.createEl("button", {
        cls: "codex-bridge-mention-chip-remove",
        text: "×"
      });
      removeBtn.type = "button";
      removeBtn.title = mention.type === "folder" ? "移除文件夹引用" : "移除文档引用";
      removeBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.removeMentionReference(mention);
      });
    }
    this.syncContextChipsVisible();
    this.updateInputOverlayLayout();
    this.updateContextMeter();
  }

  async loadAvailableSkills() {
    try {
      this.availableSkills = await this.plugin.listAvailableSkills();
    } catch (error) {
      this.availableSkills = [];
    }
    this.renderSkillChips();
    this.renderSkillMenu();
  }

  hideSkillMenu() {
    this.skillMenuOpen = false;
    this.skillMenuTriggerBySlash = false;
    this.skillCommandRange = null;
    this.skillActiveIndex = 0;
    this.skillVisibleItems = [];
    this.updateSkillQuickButton();
    this.renderSkillMenu();
  }

  updateSkillQuickButton() {
    if (!this.skillQuickBtn) {
      return;
    }
    const count = Array.isArray(this.selectedSkills) ? this.selectedSkills.length : 0;
    this.skillQuickBtn.setText(count > 0 ? `Skills(${count})` : "Skills");
    this.skillQuickBtn.toggleClass("is-active", this.skillMenuOpen);
    this.skillQuickBtn.title = count > 0 ? `已选择 ${count} 个 skills` : "选择技能";
  }

  renderSkillMenu() {
    if (!this.skillMenuEl) {
      return;
    }
    this.skillMenuEl.empty();
    this.skillMenuEl.toggleClass("is-open", this.skillMenuOpen);
    this.updateSkillQuickButton();
    if (!this.skillMenuOpen) {
      this.skillVisibleItems = [];
      return;
    }

    const panel = this.skillMenuEl.createDiv({ cls: "codex-bridge-skill-menu-panel" });
    const head = panel.createDiv({ cls: "codex-bridge-skill-menu-head" });
    head.createDiv({ cls: "codex-bridge-skill-menu-title", text: "Skills" });
    const closeBtn = head.createEl("button", {
      cls: "codex-bridge-skill-menu-close",
      text: "×"
    });
    closeBtn.type = "button";
    closeBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.hideSkillMenu();
    });

    this.skillSearchInputEl = panel.createEl("input", {
      cls: "codex-bridge-skill-search",
      type: "text",
      placeholder: "搜索 skill 名称或路径"
    });
    this.skillSearchInputEl.value = this.skillQuery || "";
    this.skillSearchInputEl.addEventListener("input", () => {
      this.skillQuery = this.skillSearchInputEl ? this.skillSearchInputEl.value || "" : "";
      this.skillActiveIndex = 0;
      this.renderSkillMenu();
    });
    this.skillSearchInputEl.addEventListener("keydown", (event) => {
      if (this.handleSkillMenuKeydown(event)) {
        return;
      }
      event.stopPropagation();
    });

    const list = panel.createDiv({ cls: "codex-bridge-skill-list" });
    const q = String(this.skillQuery || "").trim().toLowerCase();
    const rows = (Array.isArray(this.availableSkills) ? this.availableSkills : [])
      .filter((skill) => {
        if (!q) {
          return true;
        }
        const hay = `${skill.name || ""} ${skill.id || ""} ${skill.description || ""}`.toLowerCase();
        return hay.includes(q);
      })
      .slice(0, 80);
    this.skillVisibleItems = rows;
    if (this.skillActiveIndex >= rows.length) {
      this.skillActiveIndex = Math.max(0, rows.length - 1);
    }

    if (!rows.length) {
      list.createDiv({
        cls: "codex-bridge-skill-empty",
        text: "未找到可用 skills。请确认 ~/.codex/skills 下存在 SKILL.md。"
      });
      return;
    }

    for (let i = 0; i < rows.length; i += 1) {
      const skill = rows[i];
      const selected = this.selectedSkills.includes(skill.id);
      const row = list.createEl("button", {
        cls: `codex-bridge-skill-item ${selected ? "is-selected" : ""} ${
          i === this.skillActiveIndex ? "is-active" : ""
        }`
      });
      row.type = "button";
      const iconEl = row.createDiv({ cls: "codex-bridge-skill-item-icon" });
      safeSetIcon(iconEl, "sparkles", "*");
      const textWrap = row.createDiv({ cls: "codex-bridge-skill-item-text" });
      textWrap.createDiv({ cls: "codex-bridge-skill-item-name", text: skill.name || skill.id });
      textWrap.createDiv({ cls: "codex-bridge-skill-item-path", text: skill.id || "" });
      if (skill.description) {
        textWrap.createDiv({ cls: "codex-bridge-skill-item-desc", text: skill.description });
      }
      row.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.skillActiveIndex = i;
        this.toggleSkillFromMenu(skill);
      });
    }
  }

  toggleSkillFromMenu(skill) {
    if (!skill || !skill.id) {
      return;
    }
    const has = this.selectedSkills.includes(skill.id);
    if (has) {
      this.selectedSkills = this.selectedSkills.filter((id) => id !== skill.id);
    } else if (this.selectedSkills.length < MAX_SKILLS_PER_SESSION) {
      this.selectedSkills.push(skill.id);
    } else {
      new Notice(`最多选择 ${MAX_SKILLS_PER_SESSION} 个 skills`);
      return;
    }
    this.saveDraftSkillsToSession();
    this.renderSkillChips();
    if (this.skillMenuTriggerBySlash) {
      this.consumeSlashSkillCommand();
      this.inputEl?.focus();
    } else {
      this.renderSkillMenu();
      if (this.skillSearchInputEl) {
        const keep = this.skillSearchInputEl.value || "";
        this.skillSearchInputEl.focus();
        try {
          this.skillSearchInputEl.setSelectionRange(keep.length, keep.length);
        } catch (error) {
        }
      }
    }
  }

  removeSkillReference(skillId) {
    const id = String(skillId || "").trim();
    if (!id) {
      return;
    }
    this.selectedSkills = this.selectedSkills.filter((x) => x !== id);
    this.saveDraftSkillsToSession();
    this.renderSkillChips();
    this.renderSkillMenu();
  }

  renderSkillChips() {
    if (!this.skillChipsEl) {
      return;
    }
    this.skillChipsEl.empty();
    if (!Array.isArray(this.selectedSkills) || !this.selectedSkills.length) {
      this.skillChipsEl.removeClass("is-visible");
      this.updateSkillQuickButton();
      this.syncContextChipsVisible();
      this.updateContextMeter();
      return;
    }

    const catalog = Array.isArray(this.availableSkills) ? this.availableSkills : [];
    const byId = new Map(catalog.map((s) => [s.id, s]));
    this.skillChipsEl.addClass("is-visible");
    for (const skillId of this.selectedSkills) {
      const skill = byId.get(skillId);
      const chip = this.skillChipsEl.createDiv({ cls: "codex-bridge-skill-chip" });
      const iconEl = chip.createDiv({ cls: "codex-bridge-skill-chip-icon" });
      safeSetIcon(iconEl, "sparkles", "*");
      chip.createDiv({
        cls: "codex-bridge-skill-chip-name",
        text: skill && skill.name ? skill.name : shortSkillNameFromId(skillId)
      });
      const removeBtn = chip.createEl("button", {
        cls: "codex-bridge-skill-chip-remove",
        text: "×"
      });
      removeBtn.type = "button";
      removeBtn.title = "移除 skill";
      removeBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.removeSkillReference(skillId);
      });
    }
    this.updateSkillQuickButton();
    this.syncContextChipsVisible();
    this.updateInputOverlayLayout();
    this.updateContextMeter();
  }

  updateCurrentNoteLabel() {
    if (!this.currentNoteEl) {
      return;
    }
    const note = this.plugin.getActiveNoteContext();
    const name = note.path || "未打开 Markdown 文档";
    this.currentNoteEl.setText(`当前文档: ${name}`);

    if (this.sessionMetaEl) {
      const session = this.plugin.getActiveSession();
      const title = session ? session.title || "新对话" : "新对话";
      const count = session && Array.isArray(session.messages) ? session.messages.length : 0;
      this.sessionMetaEl.setText(`会话: ${title} · ${count} 条`);
    }
  }

  renderSessionList() {
    if (!this.sessionListEl) {
      return;
    }
    this.sessionListEl.empty();
    const sessions = Array.isArray(this.plugin.chatSessions)
      ? this.plugin.chatSessions.slice(0, MAX_CHAT_WINDOWS)
      : [];
    if (!sessions.length) {
      return;
    }
    sessions.forEach((session, index) => {
      const btn = this.sessionListEl.createEl("button", {
        cls: `codex-bridge-window-tab ${
          session.id === this.plugin.activeSessionId ? "is-active" : ""
        }`,
        text: String(index + 1)
      });
      btn.type = "button";
      const count =
        session && Array.isArray(session.messages) ? session.messages.length : 0;
      btn.title = `${session.title || "新对话"} · ${count} 条`;
      btn.addEventListener("click", async () => {
        if (this.plugin.activeSessionId === session.id) {
          return;
        }
        this.plugin.activeSessionId = session.id;
        await this.plugin.persist();
        this.historyMenuOpen = false;
        this.moreMenuOpen = false;
        this.refresh();
      });
    });
  }

  renderHistoryMenu() {
    if (!this.historyMenuEl) {
      return;
    }

    this.historyMenuEl.empty();
    this.historyMenuEl.toggleClass("is-open", this.historyMenuOpen);
    if (!this.historyMenuOpen) {
      return;
    }

    const sessions = this.plugin.chatSessions;
    if (!sessions.length) {
      this.historyMenuEl.createDiv({ cls: "codex-bridge-history-empty", text: "暂无会话" });
      return;
    }

    for (const session of sessions) {
      const row = this.historyMenuEl.createDiv({
        cls: `codex-bridge-history-item ${
          session.id === this.plugin.activeSessionId ? "is-active" : ""
        }`
      });
      const titleBtn = row.createEl("button", {
        cls: "codex-bridge-history-item-main"
      });

      const title = session.title || "新对话";
      const preview = this.getSessionPreview(session);
      const timeText = this.formatSessionTime(session.updatedAt);
      titleBtn.createEl("div", { cls: "codex-bridge-history-item-title", text: title });
      titleBtn.createEl("div", {
        cls: "codex-bridge-history-item-preview",
        text: preview ? `${preview} · ${timeText}` : timeText
      });
      titleBtn.addEventListener("click", async () => {
        this.plugin.activeSessionId = session.id;
        await this.plugin.persist();
        this.historyMenuOpen = false;
        this.refresh();
      });
    }
  }

  renderMoreMenu() {
    if (!this.moreMenuEl) {
      return;
    }
    this.moreMenuEl.empty();
    this.moreMenuEl.toggleClass("is-open", this.moreMenuOpen);
    if (!this.moreMenuOpen) {
      return;
    }

    const clearBtn = this.moreMenuEl.createEl("button", {
      cls: "codex-bridge-more-item",
      text: "清空当前会话"
    });
    clearBtn.type = "button";
    clearBtn.addEventListener("click", async () => {
      const session = this.plugin.getActiveSession();
      if (!session) {
        return;
      }
      session.messages = [];
      session.updatedAt = Date.now();
      await this.plugin.persist();
      this.moreMenuOpen = false;
      this.refresh();
    });

    const deleteBtn = this.moreMenuEl.createEl("button", {
      cls: "codex-bridge-more-item is-danger",
      text: "删除当前会话"
    });
    deleteBtn.type = "button";
    deleteBtn.addEventListener("click", async () => {
      const session = this.plugin.getActiveSession();
      if (!session) {
        return;
      }
      await this.plugin.deleteSession(session.id);
      this.moreMenuOpen = false;
      this.refresh();
    });
  }

  renderMessages() {
    if (!this.messagesEl) {
      return;
    }
    this.messagesEl.empty();

    const session = this.plugin.getActiveSession();
    if (!session || !session.messages.length) {
      const empty = this.messagesEl.createDiv({ cls: "codex-bridge-empty" });
      empty.setText("开始和 Codex 对话。可使用 @ 引用文档或文件夹。\n你也可以直接基于当前打开文档提问。");
      return;
    }

    for (const message of session.messages) {
      this.appendMessage(message.role, message.content, message);
    }
  }

  appendMessage(role, content, meta) {
    const messageMeta = meta && typeof meta === "object" ? meta : {};
    const item = this.messagesEl.createDiv({ cls: `codex-bridge-msg codex-bridge-msg-${role}` });
    if (role === "assistant") {
      item.createDiv({
        cls: "codex-bridge-msg-role",
        text: "Codex"
      });
    }

    const body = item.createDiv({ cls: "codex-bridge-msg-body" });

    const renderAssistantAnswer = (container, text) => {
      if (MarkdownRenderer && typeof MarkdownRenderer.render === "function") {
        container.empty();
        container.addClass("markdown-rendered");
        const sourcePath = this.plugin.getActiveNoteContext().path || "";
        MarkdownRenderer.render(this.app, text || "", container, sourcePath, this.plugin).catch(() => {
          container.empty();
          container.setText(text || "");
        });
      } else {
        container.setText(text || "");
      }
    };

    let thoughtToggle = null;
    let thoughtPanel = null;
    let thoughtTextEl = null;
    let answerEl = null;

    const ensureThoughtBlock = () => {
      if (thoughtToggle && thoughtPanel && thoughtTextEl) {
        return;
      }
      const thoughtWrap = body.createDiv({ cls: "codex-bridge-thought-wrap" });
      thoughtToggle = thoughtWrap.createEl("button", {
        cls: "codex-bridge-thought-toggle",
        text: messageMeta.thoughtLabel || "Thought"
      });
      thoughtPanel = thoughtWrap.createDiv({ cls: "codex-bridge-thought-panel is-hidden" });
      thoughtTextEl = thoughtPanel.createDiv({ cls: "codex-bridge-thought-text" });
      thoughtToggle.addEventListener("click", () => {
        const hidden = thoughtPanel.hasClass("is-hidden");
        if (hidden) {
          thoughtPanel.removeClass("is-hidden");
          thoughtToggle.addClass("is-open");
        } else {
          thoughtPanel.addClass("is-hidden");
          thoughtToggle.removeClass("is-open");
        }
      });
    };

    if (role === "assistant") {
      ensureThoughtBlock();
      answerEl = body.createDiv({ cls: "codex-bridge-answer" });
      renderAssistantAnswer(answerEl, content || "");
    } else {
      body.setText(content || "");
    }

    if (role === "assistant") {
      const actions = item.createDiv({ cls: "codex-bridge-msg-actions" });
      const copyBtn = actions.createEl("button", { text: "复制" });
      copyBtn.addEventListener("click", async () => {
        const textToCopy =
          (answerEl && answerEl.innerText ? answerEl.innerText : "") || (content || "");
        if (!textToCopy.trim()) {
          new Notice("无可复制内容");
          return;
        }
        try {
          if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
            await navigator.clipboard.writeText(textToCopy);
          } else {
            const ta = document.createElement("textarea");
            ta.value = textToCopy;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            ta.remove();
          }
          new Notice("已复制到剪切板");
        } catch (error) {
          new Notice("复制失败");
        }
      });
    }

    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    if (role === "assistant" && messageMeta.live === true) {
      const startedAt = Date.now();
      return {
        item,
        body,
        setProgress: ({ status, thought, answer, done }) => {
          if (ensureThoughtBlock) {
            ensureThoughtBlock();
          }
          if (typeof thought === "string" && thoughtTextEl) {
            thoughtTextEl.setText(thought.trim());
          }
          if (typeof answer === "string" && answerEl) {
            renderAssistantAnswer(answerEl, answer);
          }
          if (thoughtToggle) {
            const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
            const hasRealThought = typeof thought === "string" && thought.trim().length > 0;
            if (done) {
              thoughtToggle.setText(hasRealThought ? `Thought for ${elapsed}s` : `Thought unavailable · ${elapsed}s`);
              thoughtToggle.addClass("is-done");
            } else if (status) {
              thoughtToggle.setText(`${status} · ${elapsed}s`);
              thoughtToggle.removeClass("is-done");
            } else {
              thoughtToggle.setText(`Thinking... · ${elapsed}s`);
              thoughtToggle.removeClass("is-done");
            }
          }
          if (this.messagesEl) {
            this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
          }
        }
      };
    }

    if (role === "assistant") {
      ensureThoughtBlock();
      const seconds =
        Number.isFinite(messageMeta.thoughtDurationMs) && messageMeta.thoughtDurationMs > 0
          ? Math.max(0, Math.floor(messageMeta.thoughtDurationMs / 1000))
          : 0;
      const thoughtText = (messageMeta.thought || "").trim();
      thoughtToggle.setText(
        messageMeta.thoughtLabel || (thoughtText ? `Thought for ${seconds}s` : `Thought unavailable · ${seconds}s`)
      );
      thoughtToggle.addClass("is-done");
      thoughtTextEl.setText(
        thoughtText || "Codex CLI 本轮未返回可展示的 reasoning 流。"
      );
      if (messageMeta.thoughtExpanded) {
        thoughtPanel.removeClass("is-hidden");
        thoughtToggle.addClass("is-open");
      } else {
        thoughtPanel.addClass("is-hidden");
        thoughtToggle.removeClass("is-open");
      }
    }

    return { item, body };
  }

  getSessionPreview(session) {
    if (!session || !Array.isArray(session.messages) || !session.messages.length) {
      return "";
    }
    const last = session.messages[session.messages.length - 1];
    const text = (last && typeof last.content === "string" ? last.content : "").replace(/\s+/g, " ").trim();
    return text.slice(0, 28);
  }

  formatSessionTime(ts) {
    if (!ts) {
      return "";
    }
    try {
      return new Date(ts).toLocaleString([], {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit"
      });
    } catch (error) {
      return "";
    }
  }

  async sendMessage() {
    if (this.isBusy || !this.inputEl) {
      return;
    }

    const typedText = (this.inputEl.value || "").trim();
    const imagePaths = this.selectedImages.map((img) => img.path).filter(Boolean);
    const imageNames = this.selectedImages.map((img) => img.name).filter(Boolean);
    const mentionTokens = this.selectedMentions.map((m) => `@[[${m.path}]]`);
    const userText = [mentionTokens.join(" "), typedText].filter(Boolean).join(" ").trim();
    if (!userText && !imagePaths.length) {
      return;
    }

    let session = this.plugin.getActiveSession();
    if (!session) {
      new Notice("会话未初始化，请重试");
      return;
    }
    const sessionId = session.id;
    const getSessionRef = () =>
      this.plugin.chatSessions.find((s) => s && s.id === sessionId) || this.plugin.getActiveSession();
    this.plugin.captureCurrentMarkdownContext();

    this.isBusy = true;
    this.sendButton?.setAttribute("disabled", "true");
    this.inputEl.value = "";
    this.selectedMentions = [];
    this.renderMentionChips();
    this.saveDraftMentionsToSession();
    this.clearImageAttachments();
    this.updateInputActionButton();
    const userDisplayText =
      (typedText || userText || "").trim() +
      (imageNames.length ? `\n[附图 ${imageNames.length} 张: ${imageNames.join(", ")}]` : "");
    session.messages.push({ role: "user", content: userDisplayText.trim() || "(图片)" });
    session.updatedAt = Date.now();
    if (!session.title || session.title === "新对话") {
      session.title = (typedText || userText || (imageNames.length ? "图片提问" : "")).slice(0, 24);
    }
    trimSessionMessages(session);
    await this.plugin.persist();
    session = getSessionRef();
    if (!session) {
      this.isBusy = false;
      this.sendButton?.removeAttribute("disabled");
      this.updateInputActionButton();
      new Notice("会话状态已失效，请重试");
      return;
    }

    this.updateCurrentNoteLabel();
    this.renderSessionList();
    this.renderHistoryMenu();
    this.appendMessage("user", userDisplayText || "(图片)");
    const pending = this.appendMessage("assistant", "", { live: true });
    const pendingStartedAt = Date.now();
    let pendingStatus = "Thinking...";
    let pendingReasoning = "";
    let pendingAnswer = "";
    const flushPending = (done) => {
      if (pending && typeof pending.setProgress === "function") {
        pending.setProgress({
          status: pendingStatus,
          thought: pendingReasoning,
          answer: pendingAnswer,
          done: Boolean(done)
        });
      }
    };
    flushPending();
    const pendingTicker = window.setInterval(() => {
      flushPending(false);
    }, 1000);

    try {
      const autoCompactResult = await this.plugin.maybeAutoCompactSessionContext(session, userText);
      session = getSessionRef();
      if (!session) {
        throw new Error("会话状态已失效，请重试");
      }
      if (autoCompactResult && autoCompactResult.performed) {
        new Notice("上下文占用较高，已自动压缩历史上下文");
      }
      const promptInput = [userText, imageNames.length ? `附图: ${imageNames.join(", ")}` : ""]
        .filter(Boolean)
        .join("\n");
      const prompt = await this.plugin.buildChatPrompt(promptInput, session);
      this.plugin.markSessionPromptUsage(session, estimateTextTokens(prompt));
      this.updateContextMeter();
      const onProgress = (event) => {
        if (!event || typeof event !== "object") {
          return;
        }
        if (event.type === "status" && event.text) {
          pendingStatus = event.text;
          flushPending();
          return;
        }
        if (event.type === "delta" && event.text) {
          pendingAnswer += event.text;
          flushPending();
          return;
        }
        if (event.type === "reasoning" && event.text) {
          pendingReasoning += event.text;
          if (pendingReasoning.length > 1200) {
            pendingReasoning = pendingReasoning.slice(-1200);
          }
          flushPending();
          return;
        }
        if (event.type === "tool" && event.text) {
          pendingStatus = event.text;
          flushPending();
        }
      };
      const result = await this.plugin.runCodex(prompt, session, onProgress, imagePaths);
      session = getSessionRef();
      if (!session) {
        throw new Error("会话状态已失效，请重试");
      }
      const assistantText = (result && result.text ? result.text : "").trim() || "(空响应)";
      if (result && result.sessionId) {
        session.codexSessionId = result.sessionId;
      }
      if (result && result.threadId) {
        session.codexThreadId = result.threadId;
      }

      const finalThoughtLabel = `Thought for ${Math.max(0, Math.floor((Date.now() - pendingStartedAt) / 1000))}s`;
      pendingStatus = finalThoughtLabel;
      flushPending(true);
      pending.item.remove();
      const finalAssistantMessage = {
        role: "assistant",
        content: assistantText,
        thought: pendingReasoning.trim().slice(0, 6000),
        thoughtDurationMs: Date.now() - pendingStartedAt,
        thoughtLabel: finalThoughtLabel,
        thoughtExpanded: false
      };
      session.messages.push(finalAssistantMessage);
      session.updatedAt = Date.now();
      trimSessionMessages(session);
      await this.plugin.persist();

      this.updateCurrentNoteLabel();
      this.renderSessionList();
      this.renderHistoryMenu();
      this.appendMessage("assistant", assistantText, {
        thought: pendingReasoning.trim(),
        thoughtDurationMs: Date.now() - pendingStartedAt,
        thoughtLabel: finalThoughtLabel,
        thoughtExpanded: false
      });
    } catch (error) {
      session = getSessionRef();
      pending.item.remove();
      const elapsedMs = Date.now() - pendingStartedAt;
      let assistantText = "";
      if (pendingAnswer && pendingAnswer.trim()) {
        assistantText = pendingAnswer.trim();
      } else if (isInterruptedError(error)) {
        assistantText = "已中断本次生成。";
      } else {
        assistantText = `执行失败：${error.message}`;
      }
      const failedAssistantMessage = {
        role: "assistant",
        content: assistantText,
        thought: pendingReasoning.trim().slice(0, 6000),
        thoughtDurationMs: elapsedMs,
        thoughtLabel: `Thought for ${Math.max(0, Math.floor(elapsedMs / 1000))}s`,
        thoughtExpanded: false
      };
      if (session) {
        session.messages.push(failedAssistantMessage);
      }
      this.appendMessage("assistant", assistantText, {
        thought: pendingReasoning.trim(),
        thoughtDurationMs: elapsedMs,
        thoughtLabel: `Thought for ${Math.max(0, Math.floor(elapsedMs / 1000))}s`,
        thoughtExpanded: false
      });
      if (session) {
        session.updatedAt = Date.now();
        trimSessionMessages(session);
      }
      await this.plugin.persist().catch(() => {});
      this.updateCurrentNoteLabel();
      this.renderSessionList();
      this.renderHistoryMenu();
      if (!isInterruptedError(error)) {
        new Notice(`Codex 执行失败: ${error.message}`);
      }
    } finally {
      window.clearInterval(pendingTicker);
      this.isBusy = false;
      this.sendButton?.removeAttribute("disabled");
      this.updateInputActionButton();
    }
  }

}

class CodexBridgeSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Codex Bridge" });

    new Setting(containerEl)
      .setName("Codex 命令")
      .setDesc("默认是 codex。也可改成绝对路径。")
      .addText((text) =>
        text
          .setPlaceholder("codex")
          .setValue(this.plugin.settings.codexCommand)
          .onChange(async (value) => {
            this.plugin.settings.codexCommand = value.trim() || "codex";
            await this.plugin.persist();
          })
      );

    new Setting(containerEl)
      .setName("附加参数")
      .setDesc("传给 codex exec 的参数。示例：--full-auto -m gpt-5")
      .addTextArea((text) =>
        text
          .setPlaceholder("--full-auto")
          .setValue(this.plugin.settings.codexArgs)
          .onChange(async (value) => {
            this.plugin.settings.codexArgs = value;
            await this.plugin.persist();
          })
      );

    new Setting(containerEl)
      .setName("默认模型")
      .setDesc("聊天下拉框使用的当前模型。")
      .addDropdown((dropdown) => {
        const models = this.plugin.getModelOptions();
        for (const m of models) {
          dropdown.addOption(m, m);
        }
        dropdown.setValue(this.plugin.getSelectedModel()).onChange(async (value) => {
          await this.plugin.setSelectedModel(value);
        });
      });

    new Setting(containerEl)
      .setName("模型列表")
      .setDesc("逗号分隔。用于聊天下拉切换。")
      .addText((text) =>
        text
          .setPlaceholder("gpt-5,gpt-5-mini,gpt-4.1")
          .setValue(this.plugin.settings.modelOptions || "")
          .onChange(async (value) => {
            this.plugin.settings.modelOptions = value;
            const options = this.plugin.getModelOptions();
            if (!options.includes(this.plugin.settings.selectedModel)) {
              this.plugin.settings.selectedModel = options[0] || "gpt-5";
            }
            await this.plugin.persist();
            this.display();
          })
      );

    new Setting(containerEl)
      .setName("默认模式")
      .setDesc("Agent: 允许模型改文件；Ask: 仅对话。")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.isAgentMode())
          .onChange(async (value) => {
            await this.plugin.setAgentMode(value, this.plugin.getActiveSession());
          })
      );

    new Setting(containerEl)
      .setName("发送快捷键")
      .setDesc("智能 Enter 模式：输入法上屏时不发送，非输入法状态回车直接发送。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("enter", "智能 Enter 发送（Shift+Enter 换行）")
          .addOption("mod-enter", "Cmd/Ctrl+Enter 发送")
          .setValue(this.plugin.getSendShortcutMode())
          .onChange(async (value) => {
            this.plugin.settings.sendShortcut = value === "enter" ? "enter" : "mod-enter";
            await this.plugin.persist();
            const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CODEX_CHAT);
            for (const leaf of leaves) {
              const view = leaf.view;
              if (view instanceof CodexChatView) {
                view.updateInputPlaceholder();
              }
            }
          })
      );

    new Setting(containerEl)
      .setName("1M 上下文模式（实验）")
      .setDesc("对齐 Claudian：关闭为约 200k 历史预算，开启为约 1M 历史预算。")
      .addToggle((toggle) =>
        toggle
          .setValue(!!this.plugin.settings.show1MContext)
          .onChange(async (value) => {
            this.plugin.settings.show1MContext = !!value;
            await this.plugin.persist();
          })
      );

    new Setting(containerEl)
      .setName("原生会话上下文")
      .setDesc("开启后优先使用 Codex 原生多轮记忆，仅在显式选区/@文档时附加上下文。")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.nativeContextMode !== false)
          .onChange(async (value) => {
            this.plugin.settings.nativeContextMode = value;
            await this.plugin.persist();
          })
      );

    new Setting(containerEl)
      .setName("应用方式")
      .setDesc("replace: 替换目标文本；append: 在目标后追加结果")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("replace", "replace")
          .addOption("append", "append")
          .setValue(this.plugin.settings.applyMode)
          .onChange(async (value) => {
            this.plugin.settings.applyMode = value;
            await this.plugin.persist();
          })
      );

    new Setting(containerEl)
      .setName("Chat 系统提示词")
      .setDesc("用于侧栏聊天模式。")
      .addTextArea((text) =>
        text
          .setValue(this.plugin.settings.chatSystemPrompt)
          .onChange(async (value) => {
            this.plugin.settings.chatSystemPrompt = value;
            await this.plugin.persist();
          })
      );

    new Setting(containerEl)
      .setName("聊天时附带当前笔记")
      .setDesc("开启后，侧栏对话会附带当前打开笔记内容（截断到 12000 字符）。")
      .addToggle((toggle) =>
        toggle
          .setValue(!!this.plugin.settings.includeNoteContextInChat)
          .onChange(async (value) => {
            this.plugin.settings.includeNoteContextInChat = value;
            await this.plugin.persist();
          })
      );

    new Setting(containerEl)
      .setName("Prompt 模板")
      .setDesc("用于命令式文本处理。可用变量：{{instruction}} {{text}} {{file}}")
      .addTextArea((text) =>
        text
          .setValue(this.plugin.settings.promptTemplate)
          .onChange(async (value) => {
            this.plugin.settings.promptTemplate = value;
            await this.plugin.persist();
          })
      );
  }
}

module.exports = class CodexBridgePlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS);
    this.chatSessions = [];
    this.activeSessionId = "";
    this.persistChain = Promise.resolve();
    this.skillCatalogCache = {
      ts: 0,
      items: []
    };
    this.lastMarkdownPath = "";
    this.lastMarkdownText = "";
    this.lastSelectionPath = "";
    this.lastSelectionText = "";
    this.lastSelectionLineCount = 0;
    this.activeRunCancel = null;

    try {
      await this.loadPluginState();
    } catch (error) {
      console.error("[codex-bridge] loadPluginState failed:", error);
      this.settings = Object.assign({}, DEFAULT_SETTINGS);
      const now = Date.now();
      this.chatSessions = [
        {
          id: newId(),
          title: "新对话",
          createdAt: now,
          updatedAt: now,
          messages: [],
          codexSessionId: "",
          codexThreadId: "",
          draftMentions: [],
          draftSkills: [],
          compactedContext: "",
          lastPromptTokens: 0,
          autoDocMentionDisabled: false,
          autoDocMentionSeeded: false
        }
      ];
      this.activeSessionId = this.chatSessions[0].id;
      await this.persist().catch(() => {});
      new Notice("Codex Bridge 初始化异常，已回退到默认会话。");
    }
    this.captureCurrentMarkdownContext();

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        this.captureMarkdownContextFromLeaf(leaf);
      })
    );
    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        this.captureCurrentMarkdownContext();
      })
    );
    this.registerEvent(
      this.app.workspace.on("editor-change", () => {
        this.captureCurrentMarkdownContext();
      })
    );
    if (this.app.workspace && typeof this.app.workspace.onLayoutReady === "function") {
      this.app.workspace.onLayoutReady(() => {
        this.captureCurrentMarkdownContext();
      });
    }

    this.registerView(VIEW_TYPE_CODEX_CHAT, (leaf) => new CodexChatView(leaf, this));

    this.addRibbonIcon("bot", "Open Codex Chat", async () => {
      await this.activateChatView();
    });

    this.addCommand({
      id: "codex-open-chat",
      name: "Codex: Open chat sidebar",
      callback: async () => {
        await this.activateChatView();
      }
    });

    this.addCommand({
      id: "codex-new-chat",
      name: "Codex: Start new chat",
      callback: async () => {
        await this.createNewSession();
        await this.activateChatView();
      }
    });

    this.addCommand({
      id: "codex-process-selection",
      name: "Codex: Process selected text",
      editorCallback: async (editor, view) => {
        const selected = editor.getSelection();
        if (!selected || !selected.trim()) {
          new Notice("请先选中要处理的文本");
          return;
        }
        const filePath = view.file ? view.file.path : "";
        await this.processText(editor, selected, true, filePath);
      }
    });

    this.addCommand({
      id: "codex-process-note",
      name: "Codex: Process full note",
      editorCallback: async (editor, view) => {
        const fullText = editor.getValue();
        if (!fullText || !fullText.trim()) {
          new Notice("当前笔记为空");
          return;
        }
        const filePath = view.file ? view.file.path : "";
        await this.processText(editor, fullText, false, filePath);
      }
    });

    this.addSettingTab(new CodexBridgeSettingTab(this.app, this));
  }

  async onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_CODEX_CHAT);
  }

  async activateChatView() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_CODEX_CHAT)[0];

    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE_CODEX_CHAT, active: true });
    }

    this.app.workspace.revealLeaf(leaf);
  }

  async loadPluginState() {
    const stored = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);
    const hadPendingMessages = Array.isArray(stored.chatSessions)
      ? stored.chatSessions.some(
          (s) => Array.isArray(s && s.messages) && s.messages.some((m) => m && m.pending === true)
        )
      : false;

    if (Array.isArray(stored.chatSessions) && stored.chatSessions.length) {
      const normalized = stored.chatSessions
        .map(normalizeSession)
        .filter(Boolean)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_CHAT_HISTORY);
      if (normalized.length) {
        this.chatSessions = normalized;
        this.activeSessionId = stored.activeSessionId || normalized[0].id;
        if (hadPendingMessages) {
          await this.persist().catch(() => {});
        }
        return;
      }
    }

    const legacyMessages = Array.isArray(stored.chatHistory) ? stored.chatHistory : [];
    const initialSession = {
      id: newId(),
      title: "新对话",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: legacyMessages,
      codexSessionId: "",
      codexThreadId: "",
      draftMentions: [],
      draftSkills: [],
      compactedContext: "",
      lastPromptTokens: 0,
      autoDocMentionDisabled: false,
      autoDocMentionSeeded: false
    };

    this.chatSessions = [initialSession];
    this.activeSessionId = initialSession.id;
    await this.persist();
  }

  async persist() {
    const doPersist = async () => {
      this.chatSessions = this.chatSessions
        .map(normalizeSession)
        .filter(Boolean)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_CHAT_HISTORY);

      if (!this.chatSessions.length) {
        const session = {
          id: newId(),
          title: "新对话",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messages: [],
          codexSessionId: "",
          codexThreadId: "",
          draftMentions: [],
          draftSkills: [],
          compactedContext: "",
          lastPromptTokens: 0,
          autoDocMentionDisabled: false,
          autoDocMentionSeeded: false
        };
        this.chatSessions = [session];
        this.activeSessionId = session.id;
      }

      if (!this.chatSessions.some((s) => s.id === this.activeSessionId)) {
        this.activeSessionId = this.chatSessions[0].id;
      }

      const data = Object.assign({}, this.settings, {
        chatSessions: this.chatSessions,
        activeSessionId: this.activeSessionId
      });
      await this.saveData(data);
    };

    this.persistChain = this.persistChain.then(doPersist, doPersist);
    return this.persistChain;
  }

  getActiveSession() {
    let session = this.chatSessions.find((s) => s.id === this.activeSessionId);
    if (!session && this.chatSessions.length) {
      session = this.chatSessions[0];
      this.activeSessionId = session.id;
    }
    return session || null;
  }

  async createNewSession() {
    const now = Date.now();
    const session = {
      id: newId(),
      title: "新对话",
      createdAt: now,
      updatedAt: now,
      messages: [],
      codexSessionId: "",
      codexThreadId: "",
      draftMentions: [],
      draftSkills: [],
      compactedContext: "",
      lastPromptTokens: 0,
      autoDocMentionDisabled: false,
      autoDocMentionSeeded: false
    };
    this.chatSessions.unshift(session);
    this.activeSessionId = session.id;
    await this.persist();
  }

  async deleteSession(sessionId) {
    this.chatSessions = this.chatSessions.filter((s) => s.id !== sessionId);
    if (!this.chatSessions.length) {
      await this.createNewSession();
      return;
    }

    if (this.activeSessionId === sessionId) {
      this.activeSessionId = this.chatSessions[0].id;
    }
    await this.persist();
  }

  getModelOptions() {
    const raw = String(this.settings.modelOptions || "");
    const normalizedRaw = raw.replace(/\s+/g, "");
    const source =
      !normalizedRaw || normalizedRaw === LEGACY_MODEL_OPTIONS
        ? RECOMMENDED_MODEL_OPTIONS
        : raw;
    const list = source
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    if (!list.length) {
      return RECOMMENDED_MODEL_OPTIONS.split(",");
    }
    return [...new Set(list)];
  }

  getSelectedModel() {
    const fromSetting = String(this.settings.selectedModel || "").trim();
    if (fromSetting) {
      return fromSetting;
    }
    const fromArgs = pickModelFromArgs(splitArgs(this.settings.codexArgs));
    return fromArgs || "gpt-5";
  }

  async setSelectedModel(model) {
    const next = String(model || "").trim();
    if (!next) {
      return;
    }
    this.settings.selectedModel = next;
    await this.persist();
  }

  getSendShortcutMode() {
    const raw = String(this.settings.sendShortcut || "").trim().toLowerCase();
    return raw === "enter" ? "enter" : "mod-enter";
  }

  getContextWindowBudget() {
    return this.settings.show1MContext ? CONTEXT_WINDOW_1M : CONTEXT_WINDOW_STANDARD;
  }

  estimateContextUsage(session, options) {
    const opts = options && typeof options === "object" ? options : {};
    const max = this.getContextWindowBudget();
    if (!session) {
      return { used: 0, max, ratio: 0 };
    }
    const draftInput = String(opts.draftInput || "");
    const mentions = Array.isArray(opts.mentions) ? opts.mentions : [];
    const skills = Array.isArray(opts.skills) ? opts.skills : [];
    const imageCount = Number.isFinite(opts.imageCount) ? Math.max(0, Number(opts.imageCount)) : 0;
    let used = 0;

    if (Array.isArray(session.messages)) {
      const recentMessages = session.messages.slice(-Math.max(20, Math.floor(MAX_SESSION_MESSAGES * 0.7)));
      for (const msg of recentMessages) {
        if (!msg || typeof msg.content !== "string") {
          continue;
        }
        used += estimateTextTokens(`${msg.role || "user"}\n${msg.content}`);
      }
    }
    if (session.compactedContext && String(session.compactedContext).trim()) {
      used += estimateTextTokens(String(session.compactedContext)) + 80;
    }
    if (this.settings.includeNoteContextInChat && this.lastMarkdownText) {
      used += estimateTextTokens(clampText(this.lastMarkdownText, 4000));
    }
    if (this.lastSelectionText) {
      used += estimateTextTokens(clampText(this.lastSelectionText, 2000));
    }
    if (mentions.length) {
      for (const m of mentions) {
        used += m && m.type === "folder" ? 1800 : 700;
      }
    }
    if (skills.length) {
      used += skills.length * 420;
    }
    if (imageCount > 0) {
      used += imageCount * 1200;
    }
    if (draftInput) {
      used += estimateTextTokens(draftInput);
    }
    if (Number.isFinite(session.lastPromptTokens) && session.lastPromptTokens > 0) {
      used = Math.max(used, Math.floor(session.lastPromptTokens));
    }
    const ratio = max > 0 ? Math.max(0, Math.min(1.2, used / max)) : 0;
    return { used, max, ratio };
  }

  markSessionPromptUsage(session, tokens) {
    if (!session || !Number.isFinite(tokens) || tokens <= 0) {
      return;
    }
    session.lastPromptTokens = Math.floor(tokens);
    session.updatedAt = Date.now();
    this.persist().catch(() => {});
  }

  async maybeAutoCompactSessionContext(session, draftInput) {
    if (!session || session.contextCompacting) {
      return { performed: false };
    }
    const usage = this.estimateContextUsage(session, { draftInput });
    if (usage.ratio < CONTEXT_COMPACT_SOFT_RATIO) {
      return { performed: false, usage };
    }
    return this.compactSessionContext(
      session,
      usage.ratio >= CONTEXT_COMPACT_HARD_RATIO ? "auto-hard" : "auto-soft"
    );
  }

  async compactSessionContext(session, reason) {
    if (!session || session.contextCompacting) {
      return { performed: false };
    }
    const existingMessages = Array.isArray(session.messages) ? session.messages : [];
    if (existingMessages.length <= CONTEXT_COMPACT_KEEP_RECENT_MESSAGES + 1) {
      return { performed: false };
    }
    const toSummarize = existingMessages.slice(
      0,
      Math.max(0, existingMessages.length - CONTEXT_COMPACT_KEEP_RECENT_MESSAGES)
    );
    if (!toSummarize.length) {
      return { performed: false };
    }

    session.contextCompacting = true;
    try {
      const transcript = toSummarize
        .map((msg) => {
          const role = msg && msg.role === "assistant" ? "助手" : "用户";
          const content = msg && typeof msg.content === "string" ? msg.content.trim() : "";
          return `${role}:\n${content}`;
        })
        .join("\n\n")
        .slice(0, 90000);
      const summaryPrompt = [
        "请把下面这段多轮对话压缩为“可继续对话的上下文记忆”。",
        "要求：",
        "1) 用中文，简洁且信息完整。",
        "2) 保留用户目标、约束、偏好、已完成事项、未完成事项、关键结论。",
        "3) 输出 Markdown，使用小标题和要点列表。",
        "4) 不要杜撰未出现的事实。",
        "",
        "对话内容：",
        transcript
      ].join("\n");
      let summaryText = "";
      try {
        const result = await this.runCodex(summaryPrompt, null, null, []);
        summaryText = String((result && result.text) || "").trim();
      } catch (error) {
        summaryText = "";
      }
      if (!summaryText) {
        const fallback = toSummarize
          .slice(-6)
          .map((msg) => `${msg.role === "assistant" ? "助手" : "用户"}: ${String(msg.content || "").slice(0, 260)}`)
          .join("\n");
        summaryText = `## 历史上下文摘要（自动回退）\n${fallback}`.trim();
      }

      session.compactedContext = [String(session.compactedContext || "").trim(), summaryText]
        .filter(Boolean)
        .join("\n\n")
        .slice(0, MAX_COMPACT_SUMMARY_CHARS);
      session.messages = existingMessages.slice(-CONTEXT_COMPACT_KEEP_RECENT_MESSAGES);
      session.messages.unshift({
        role: "assistant",
        content: `（上下文已压缩：${toSummarize.length} 条历史消息，原因：${reason || "manual"}）`
      });
      session.lastPromptTokens = 0;
      session.updatedAt = Date.now();
      trimSessionMessages(session);
      await this.persist();
      return { performed: true, summarizedCount: toSummarize.length };
    } finally {
      session.contextCompacting = false;
    }
  }

  isAgentMode() {
    return this.settings.agentMode !== false;
  }

  async setAgentMode(enabled, session) {
    this.settings.agentMode = Boolean(enabled);
    if (session) {
      session.updatedAt = Date.now();
      trimSessionMessages(session);
    }
    await this.persist();
  }

  setActiveRunCanceler(canceler) {
    this.activeRunCancel = typeof canceler === "function" ? canceler : null;
  }

  clearActiveRunCanceler() {
    this.activeRunCancel = null;
  }

  interruptActiveRun() {
    if (typeof this.activeRunCancel !== "function") {
      return false;
    }
    try {
      this.activeRunCancel();
      return true;
    } catch (error) {
      return false;
    }
  }

  async buildChatPrompt(userInput, session) {
    const trimmedInput = String(userInput || "").trim();
    const contextBudget = this.getContextWindowBudget();
    const lastAssistantOutput = getLastAssistantMessage(
      session,
      trimmedInput,
      Math.min(50000, Math.max(12000, Math.floor(contextBudget * 0.12)))
    );
    const carryFromLastAssistant = shouldCarryForwardLastAssistant(trimmedInput);
    const selectedSkills = await this.resolveSelectedSkills(session);
    if (this.settings.nativeContextMode !== false) {
      const refs = await this.resolveMentions(userInput);
      const selection = this.getActiveSelectionContext();
      const note = await this.getPromptNoteContext();
      const compactHistory = formatConversationHistoryWithBudget(
        session,
        trimmedInput,
        40,
        Math.floor(contextBudget * 0.8),
        12000
      );
      const blocks = [];
      blocks.push("你是 Obsidian 对话助手。直接回答用户问题，不要把对话路由成“在 vault 里做什么”。");
      blocks.push("默认使用中文回答，除非用户明确要求其他语言。");
      blocks.push("如果用户提到“上文/刚才/继续/用中文回答我”，默认指当前会话上一轮上下文，不要丢失话题。");
      if (compactHistory) {
        blocks.push(compactHistory);
      }
      if (session && session.compactedContext && String(session.compactedContext).trim()) {
        blocks.push(`压缩后的长期会话记忆:\n${String(session.compactedContext).trim()}`);
      }
      if (selectedSkills.length) {
        blocks.push(formatSkillRefsForPrompt(selectedSkills));
      }
      if (carryFromLastAssistant && lastAssistantOutput) {
        blocks.push(`上轮助手结果（本轮可直接引用）:\n${lastAssistantOutput}`);
      }
      if (selection && selection.lineCount > 0 && selection.text && selection.text.trim()) {
        blocks.push(
          `当前选中文本（${selection.lineCount} 行）:\n路径: ${selection.path || "unknown"}\n内容:\n${selection.text}`
        );
      }
      if (refs.length) {
        blocks.push(`引用文档:\n${formatMentionRefsForPrompt(refs)}`);
      }
      if (!refs.length && this.settings.includeNoteContextInChat && note.path && (note.text || "").trim()) {
        blocks.push(`当前文档:\n路径: ${note.path}\n内容:\n${note.text}`);
      }
      blocks.push(
        this.isAgentMode()
          ? "请直接完成用户请求；若请求涉及文件操作，请在当前 vault 内实际执行并给出结果。"
          : "当前为 Ask 模式：仅对话回答，不执行文件修改。"
      );
      if (/(中文|汉语)/.test(trimmedInput) || /[\u4e00-\u9fa5]/.test(trimmedInput)) {
        blocks.push("请用中文回答。");
      }
      blocks.push(`用户消息:\n${trimmedInput}`);
      return blocks.filter(Boolean).join("\n\n");
    }
    const historyCount = session && Array.isArray(session.messages) ? session.messages.length : 0;
    const shortChatIntent = historyCount <= 1 ? rewriteShortChatIntent(trimmedInput) : "";
    if (shortChatIntent) {
      return shortChatIntent;
    }

    const note = await this.getPromptNoteContext();
    const vaultPath = this.app.vault && this.app.vault.adapter ? this.app.vault.adapter.basePath || "" : "";
    const scopeLine = vaultPath ? `当前 Vault 根目录: ${vaultPath}` : "";
    const selection = this.getActiveSelectionContext();
    const selectionBlock =
      selection && selection.lineCount > 0 && selection.text && selection.text.trim()
        ? `当前选中文本（${selection.lineCount} 行）:\n路径: ${selection.path || "unknown"}\n内容:\n${selection.text}`
        : "";
    const taskIntent = detectDocIntent(trimmedInput);
    const historyBlock = formatConversationHistory(session, trimmedInput);

    const noteSection = this.settings.includeNoteContextInChat
      ? `当前打开文档: ${note.path || "unknown"}\n文档内容:\n${note.text || "(空)"}`
      : "当前文档上下文: (已关闭)";

    const refs = await this.resolveMentions(userInput);
    if (taskIntent === "文档总结") {
      const docs = refs.length
        ? refs.map((r, i) => formatOneMentionRefForPrompt(r, i, true))
        : [`文档路径: ${note.path || "unknown"}\n文档内容:\n${note.text || ""}`];
      const hasDocText = refs.length ? hasMentionRefText(refs) : docs.some((d) => /\S/.test(d.replace(/文档\d*路径:[^\n]*\n?/g, "")));
      if (!hasDocText) {
        return (
          "请用中文回答：未获取到文档内容，请先打开目标文档或使用 @[[文档路径]] 引用后再总结。"
        );
      }
      return (
        "你是文档总结助手。请直接完成任务，不要反问用户。\n\n" +
        (scopeLine ? `${scopeLine}\n\n` : "") +
        (historyBlock ? `${historyBlock}\n\n` : "") +
        `用户请求:\n${userInput}\n\n` +
        (selectionBlock ? `${selectionBlock}\n\n` : "") +
        "输出格式:\n" +
        "1) 三行摘要\n" +
        "2) 关键要点（3-6条）\n" +
        "3) 可执行建议（2-4条）\n\n" +
        `${docs.join("\n\n")}\n\n` +
        "只输出最终总结正文。"
      );
    }

    if (taskIntent === "文档改写") {
      const docs = refs.length
        ? refs.map((r, i) => formatOneMentionRefForPrompt(r, i, true))
        : [`文档路径: ${note.path || "unknown"}\n文档内容:\n${note.text || ""}`];
      const hasDocText = refs.length ? hasMentionRefText(refs) : docs.some((d) => /\S/.test(d.replace(/文档\d*路径:[^\n]*\n?/g, "")));
      if (!hasDocText) {
        return (
          "请用中文回答：未获取到文档内容，请先打开目标文档或使用 @[[文档路径]] 引用后再改写。"
        );
      }
      return (
        "你是文档改写助手。请直接完成改写，不要反问用户。\n\n" +
        (scopeLine ? `${scopeLine}\n\n` : "") +
        (historyBlock ? `${historyBlock}\n\n` : "") +
        `用户请求:\n${userInput}\n\n` +
        (selectionBlock ? `${selectionBlock}\n\n` : "") +
        "要求:\n- 保持原意\n- 语言更清晰\n- 保留 Markdown 结构\n\n" +
        `${docs.join("\n\n")}\n\n` +
        "只输出改写后的最终文本。"
      );
    }

    if (taskIntent === "文档任务") {
      const docs = refs.length
        ? refs.map((r, i) => formatOneMentionRefForPrompt(r, i, true))
        : [`文档路径: ${note.path || "unknown"}\n文档内容:\n${note.text || ""}`];
      const hasDocText = refs.length ? hasMentionRefText(refs) : docs.some((d) => /\S/.test(d.replace(/文档\d*路径:[^\n]*\n?/g, "")));
      if (!hasDocText) {
        return (
          "请用中文回答：未获取到文档内容，请先打开目标文档或使用 @[[文档路径]] 引用后再执行任务。"
        );
      }
      return (
        "你是文档任务助手。请直接执行用户任务，不要反问用户。\n\n" +
        (scopeLine ? `${scopeLine}\n\n` : "") +
        (historyBlock ? `${historyBlock}\n\n` : "") +
        `用户任务:\n${userInput}\n\n` +
        (selectionBlock ? `${selectionBlock}\n\n` : "") +
        "执行规则:\n" +
        "- 以提供的文档内容为主\n" +
        "- 若用户要求总结/提炼/分析/问答/翻译/改写，直接给结果\n" +
        "- 仅当文档内容为空时才提示补充上下文\n\n" +
        `${docs.join("\n\n")}\n\n` +
        "请直接输出最终结果。"
      );
    }

    const needsDocContext = shouldAttachDocContext(userInput, refs.length > 0);
    const contextBlocks = [];
    if (selectedSkills.length) {
      contextBlocks.push(formatSkillRefsForPrompt(selectedSkills));
    }
    if (session && session.compactedContext && String(session.compactedContext).trim()) {
      contextBlocks.push(`压缩后的长期会话记忆:\n${String(session.compactedContext).trim()}`);
    }
    if (carryFromLastAssistant && lastAssistantOutput) {
      contextBlocks.push(`上轮助手结果（本轮可直接引用）:\n${lastAssistantOutput}`);
    }
    if (selectionBlock) {
      contextBlocks.push(selectionBlock);
    }
    if (needsDocContext) {
      if (refs.length) {
        contextBlocks.push(`引用文档:\n${formatMentionRefsForPrompt(refs)}`);
      } else if (note.path && (note.text || "").trim()) {
        contextBlocks.push(`当前文档路径: ${note.path}\n当前文档内容:\n${note.text}`);
      }
    }

    return [
      "你是 Obsidian 中的 Codex 助手。",
      "请直接回答用户问题，不要把输入判定为误触字符，不要把对话转成技能或安装步骤。",
      "除非用户明确要求执行命令行操作，否则不要让用户去终端执行步骤。",
      this.isAgentMode()
        ? [
            "当前为 Agent 模式：你必须优先使用可用工具在当前 vault（cwd）内直接执行文件操作。",
            "当用户要求创建/修改/删除/写入文档时，禁止只给建议或示例路径，必须实际执行并完成。",
            "若用户未指定路径，默认使用当前文档所在目录；若当前文档不可用，则使用 vault 根目录。",
            "执行后必须再次读取目标文件进行校验，并在回复中给出“已执行”的文件路径与校验结果。"
          ].join(" ")
        : "当前为 Ask 模式：仅文字对话，不执行文件创建/修改/删除，也不执行命令。",
      "默认使用中文，答案简洁且可执行。",
      scopeLine,
      historyBlock,
      ...contextBlocks,
      `用户问题:\n${trimmedInput}`,
      "请直接输出最终答复正文。"
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  async getPromptNoteContext() {
    const fromView = this.getActiveNoteContext();
    if (fromView.path && fromView.text && fromView.text.trim()) {
      return fromView;
    }

    const candidatePath = fromView.path || this.lastMarkdownPath || "";
    if (!candidatePath) {
      return fromView;
    }

    const file = this.getMarkdownFileByLoosePath(candidatePath);
    if (!file) {
      return fromView;
    }

    try {
      const raw = await this.app.vault.cachedRead(file);
      const text = clampText(raw || "", MAX_CONTEXT_TEXT);
      if (text && text.trim()) {
        this.lastMarkdownPath = file.path;
        this.lastMarkdownText = text;
      }
      return {
        path: file.path,
        text
      };
    } catch (error) {
      return fromView;
    }
  }

  getActiveNoteContext() {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView && activeView.editor) {
      const activePath = activeView.file ? activeView.file.path : "";
      const activeText = clampText(activeView.editor.getValue() || "", MAX_CONTEXT_TEXT);
      if (activePath) {
        this.lastMarkdownPath = activePath;
        this.lastMarkdownText = activeText;
      }
      return {
        path: activePath,
        text: activeText
      };
    }

    if (this.lastMarkdownPath) {
      const openView = this.findOpenMarkdownViewByPath(this.lastMarkdownPath);
      if (openView && openView.editor) {
        const latest = clampText(openView.editor.getValue() || "", MAX_CONTEXT_TEXT);
        this.lastMarkdownText = latest;
        return {
          path: this.lastMarkdownPath,
          text: latest
        };
      }
      return {
        path: this.lastMarkdownPath,
        text: this.lastMarkdownText || ""
      };
    }

    const leaves = this.app.workspace.getLeavesOfType("markdown");
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.editor && view.file) {
        const fallbackPath = view.file.path;
        const fallbackText = clampText(view.editor.getValue() || "", MAX_CONTEXT_TEXT);
        this.lastMarkdownPath = fallbackPath;
        this.lastMarkdownText = fallbackText;
        return {
          path: fallbackPath,
          text: fallbackText
        };
      }
    }

    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile instanceof TFile && activeFile.extension === "md") {
      return {
        path: activeFile.path,
        text: this.lastMarkdownText || ""
      };
    }

    return { path: "", text: "" };
  }

  captureCurrentMarkdownContext() {
    try {
      const activeLeaf = this.app.workspace.getActiveLeaf();
      this.captureMarkdownContextFromLeaf(activeLeaf);
      if (this.lastMarkdownPath) {
        return;
      }
      const leaves = this.app.workspace.getLeavesOfType("markdown");
      for (const leaf of leaves) {
        if (this.captureMarkdownContextFromLeaf(leaf)) {
          return;
        }
      }
    } catch (error) {
      console.warn("[codex-bridge] captureCurrentMarkdownContext failed:", error);
    }
  }

  captureMarkdownContextFromLeaf(leaf) {
    if (!leaf || !leaf.view) {
      return false;
    }
    const view = leaf.view;
    if (!(view instanceof MarkdownView) || !view.editor || !view.file) {
      return false;
    }
    this.lastMarkdownPath = view.file.path;
    this.lastMarkdownText = clampText(view.editor.getValue() || "", MAX_CONTEXT_TEXT);
    this.captureSelectionFromView(view);
    return true;
  }

  captureSelectionFromView(view) {
    if (!(view instanceof MarkdownView) || !view.editor || !view.file) {
      return;
    }
    const selected = String(view.editor.getSelection() || "");
    if (!selected || !selected.trim()) {
      this.lastSelectionPath = view.file.path || "";
      this.lastSelectionText = "";
      this.lastSelectionLineCount = 0;
      return;
    }
    const normalized = selected.replace(/\r/g, "");
    const lineCount = normalized.replace(/\n+$/g, "").split("\n").length;
    this.lastSelectionPath = view.file.path || "";
    this.lastSelectionText = clampText(selected, MAX_CONTEXT_TEXT);
    this.lastSelectionLineCount = Math.max(1, lineCount);
  }

  getActiveSelectionContext() {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView && activeView.editor) {
      this.captureSelectionFromView(activeView);
    }
    if (!this.lastSelectionText || !this.lastSelectionText.trim()) {
      return { path: "", text: "", lineCount: 0 };
    }
    return {
      path: this.lastSelectionPath || this.lastMarkdownPath || "",
      text: this.lastSelectionText,
      lineCount: this.lastSelectionLineCount || 0
    };
  }

  clearActiveSelectionContext() {
    this.lastSelectionPath = "";
    this.lastSelectionText = "";
    this.lastSelectionLineCount = 0;
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView && activeView.editor) {
      try {
        const cursor =
          typeof activeView.editor.getCursor === "function"
            ? activeView.editor.getCursor("to")
            : null;
        if (cursor && typeof activeView.editor.setSelection === "function") {
          activeView.editor.setSelection(cursor, cursor);
        }
      } catch (error) {
      }
    }
  }

  findOpenMarkdownViewByPath(pathname) {
    if (!pathname) {
      return null;
    }
    const leaves = this.app.workspace.getLeavesOfType("markdown");
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file && view.file.path === pathname) {
        return view;
      }
    }
    return null;
  }

  async resolveMentions(input) {
    const matches = [...String(input || "").matchAll(/@\[\[([^\]]+)\]\]/g)];
    const paths = [...new Set(matches.map((m) => (m[1] || "").trim()).filter(Boolean))].slice(0, 8);
    if (!paths.length) {
      return [];
    }

    const refs = [];
    for (const p of paths) {
      const file = this.getMarkdownFileByLoosePath(p);
      if (file) {
        const text = await this.app.vault.cachedRead(file);
        refs.push({
          type: "file",
          path: file.path,
          text: clampText(text || "", MAX_CONTEXT_TEXT)
        });
        continue;
      }
      const folder = this.getFolderByLoosePath(p);
      if (!folder) {
        continue;
      }
      const prefix = `${folder.path.replace(/\/+$/, "")}/`;
      const all = this.app.vault
        .getMarkdownFiles()
        .filter((f) => f.path.startsWith(prefix))
        .sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: "base" }));
      if (!all.length) {
        refs.push({
          type: "folder",
          path: folder.path,
          text: "(该文件夹下没有 Markdown 文档)"
        });
        continue;
      }
      const picked = all.slice(0, MAX_FOLDER_REF_FILES);
      const chunks = [];
      let totalChars = 0;
      for (const f of picked) {
        if (totalChars >= MAX_FOLDER_REF_TOTAL_CHARS) {
          break;
        }
        const raw = await this.app.vault.cachedRead(f);
        const clipped = clampText(raw || "", MAX_FOLDER_REF_FILE_CHARS);
        const block = `### ${f.path}\n${clipped}`;
        const nextLen = totalChars + block.length + 2;
        if (nextLen > MAX_FOLDER_REF_TOTAL_CHARS && chunks.length > 0) {
          break;
        }
        chunks.push(block);
        totalChars = nextLen;
      }
      const header = `文件夹: ${folder.path}\n已纳入 ${chunks.length}/${all.length} 个文档（有截断）`;
      refs.push({
        type: "folder",
        path: folder.path,
        text: `${header}\n\n${chunks.join("\n\n")}`.trim()
      });
    }
    return refs;
  }

  getMarkdownFileByLoosePath(inputPath) {
    const raw = (inputPath || "").trim();
    if (!raw) {
      return null;
    }

    const byExact = this.app.vault.getAbstractFileByPath(raw);
    if (byExact instanceof TFile && byExact.extension === "md") {
      return byExact;
    }

    const mdPath = raw.endsWith(".md") ? raw : `${raw}.md`;
    const byMd = this.app.vault.getAbstractFileByPath(mdPath);
    if (byMd instanceof TFile && byMd.extension === "md") {
      return byMd;
    }

    const all = this.app.vault.getMarkdownFiles();
    return all.find((f) => f.path === raw || f.path === mdPath || f.basename === raw || f.basename === inputPath) || null;
  }

  getFolderByLoosePath(inputPath) {
    const raw = (inputPath || "").trim().replace(/\/+$/, "");
    if (!raw) {
      return null;
    }
    const byExact = this.app.vault.getAbstractFileByPath(raw);
    if (byExact instanceof TFolder) {
      return byExact;
    }
    const all = this.app.vault
      .getAllLoadedFiles()
      .filter((f) => f instanceof TFolder && f.path);
    return all.find((f) => f.path === raw || f.name === raw) || null;
  }

  getSkillRoots() {
    const roots = [];
    const seen = new Set();
    const homeRoot = path.join(os.homedir(), ".codex", "skills");
    if (homeRoot && !seen.has(homeRoot)) {
      roots.push({ label: "home", root: homeRoot });
      seen.add(homeRoot);
    }
    const vaultRoot = this.app && this.app.vault && this.app.vault.adapter ? this.app.vault.adapter.basePath || "" : "";
    if (vaultRoot) {
      const localRoot = path.join(vaultRoot, ".codex", "skills");
      if (!seen.has(localRoot)) {
        roots.push({ label: "vault", root: localRoot });
        seen.add(localRoot);
      }
      const legacyVaultRoot = path.join(vaultRoot, "Skills");
      if (!seen.has(legacyVaultRoot)) {
        roots.push({ label: "vault-local", root: legacyVaultRoot });
        seen.add(legacyVaultRoot);
      }
    }
    return roots;
  }

  async listAvailableSkills(forceRefresh) {
    const now = Date.now();
    if (
      !forceRefresh &&
      this.skillCatalogCache &&
      Array.isArray(this.skillCatalogCache.items) &&
      now - Number(this.skillCatalogCache.ts || 0) < SKILL_CACHE_TTL_MS
    ) {
      return this.skillCatalogCache.items;
    }

    const items = [];
    for (const rootInfo of this.getSkillRoots()) {
      const found = scanSkillCatalog(rootInfo.root, rootInfo.label);
      for (const skill of found) {
        items.push(skill);
      }
    }
    items.sort((a, b) => {
      const byName = String(a.name || "").localeCompare(String(b.name || ""), undefined, {
        sensitivity: "base"
      });
      if (byName !== 0) {
        return byName;
      }
      return String(a.id || "").localeCompare(String(b.id || ""), undefined, {
        sensitivity: "base"
      });
    });

    this.skillCatalogCache = {
      ts: now,
      items
    };
    return items;
  }

  async resolveSelectedSkills(session) {
    const ids = normalizeSkillIds(session && session.draftSkills);
    if (!ids.length) {
      return [];
    }
    const catalog = await this.listAvailableSkills();
    const byId = new Map(catalog.map((s) => [s.id, s]));
    const refs = [];
    let total = 0;
    for (const id of ids.slice(0, MAX_SKILLS_PER_SESSION)) {
      const skill = byId.get(id);
      if (!skill) {
        continue;
      }
      const body = clampText(String(skill.body || ""), MAX_SKILL_SNIPPET_CHARS);
      const next = total + body.length;
      if (refs.length > 0 && next > MAX_CONTEXT_TEXT * 2) {
        break;
      }
      refs.push({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        body
      });
      total = next;
    }
    return refs;
  }


  async processText(editor, text, fromSelection, filePath) {
    const modal = new InstructionModal(this.app, "请润色并保持原意");
    const instruction = await modal.waitForResult();
    if (instruction === null) {
      return;
    }

    const prompt = this.settings.promptTemplate
      .replaceAll("{{instruction}}", instruction || "请润色并保持原意")
      .replaceAll("{{text}}", text)
      .replaceAll("{{file}}", filePath || "unknown");

    new Notice("Codex 正在处理中...");

    try {
      const result = await this.runCodex(prompt, null);
      const output = typeof result === "string" ? result : result && result.text ? result.text : "";
      if (!output || !output.trim()) {
        new Notice("Codex 没有返回可用结果");
        return;
      }

      if (fromSelection) {
        const selected = editor.getSelection();
        if (!selected) {
          new Notice("选区已变化，请重试");
          return;
        }
        if (this.settings.applyMode === "append") {
          editor.replaceSelection(`${selected}\n\n${output}`);
        } else {
          editor.replaceSelection(output);
        }
      } else if (this.settings.applyMode === "append") {
        editor.setValue(`${editor.getValue()}\n\n${output}`);
      } else {
        editor.setValue(output);
      }

      new Notice("Codex 处理完成");
    } catch (error) {
      new Notice(`Codex 执行失败: ${error.message}`);
    }
  }

  runCodex(prompt, session, onProgress, imagePaths) {
    if (!session) {
      return this.runCodexExec(prompt, null, onProgress, imagePaths)
        .finally(() => {
          this.clearActiveRunCanceler();
        });
    }

    // Chat always prefers app-server thread/resume (including image turns),
    // so all turns stay in one backend session.
    return this.runCodexViaAppServer(prompt, session, onProgress, imagePaths)
      .catch((error) => {
        if (isInterruptedError(error)) {
          throw error;
        }
        if (onProgress) {
          onProgress({ type: "status", text: "app-server 不可用，回退兼容模式..." });
        }
        return this.runCodexExec(prompt, session, onProgress, imagePaths);
      })
      .finally(() => {
        this.clearActiveRunCanceler();
      });
  }

  runCodexViaAppServer(prompt, session, onProgress, imagePaths) {
    const cwd = this.app.vault.adapter.basePath;
    const model = this.getSelectedModel() || pickModelFromArgs(splitArgs(this.settings.codexArgs)) || "gpt-5";
    const isAgent = this.isAgentMode();
    const sandboxMode = isAgent ? "workspace-write" : "read-only";
    const approvalPolicy = isAgent ? "never" : "never";

    return new Promise((resolve, reject) => {
      const child = spawn(this.settings.codexCommand, ["app-server"], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"]
      });

      let stderr = "";
      let stdoutBuffer = "";
      let nextId = 1;
      const pending = new Map();
      let settled = false;

      const cleanup = () => {
        child.stdout.removeAllListeners();
        child.stderr.removeAllListeners();
        child.removeAllListeners();
        if (!child.killed) {
          try {
            child.kill();
          } catch (error) {
            // ignore kill errors
          }
        }
      };

      const fail = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error || "Unknown error")));
      };

      const finish = (result) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(result);
      };

      this.setActiveRunCanceler(() => {
        fail(createInterruptedError());
      });

      const sendRequest = (method, params) =>
        new Promise((res, rej) => {
          const id = nextId++;
          pending.set(id, { res, rej });
          try {
            child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
          } catch (error) {
            pending.delete(id);
            rej(error);
          }
        });

      const sendNotification = (method, params) => {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
      };

      child.stderr.on("data", (chunk) => {
        stderr += String(chunk || "");
      });

      child.on("error", (error) => {
        fail(error);
      });

      child.on("close", (code) => {
        if (!settled) {
          fail(new Error(stderr.trim() || `app-server exit code ${code}`));
        }
      });

      let activeThreadId = "";
      let activeTurnId = "";
      let streamedText = "";
      let turnDone = null;

      child.stdout.on("data", (chunk) => {
        stdoutBuffer += String(chunk || "");
        let idx = stdoutBuffer.indexOf("\n");
        while (idx >= 0) {
          const line = stdoutBuffer.slice(0, idx).trim();
          stdoutBuffer = stdoutBuffer.slice(idx + 1);
          if (line) {
            try {
              const msg = JSON.parse(line);
              if (Object.prototype.hasOwnProperty.call(msg, "id") && pending.has(msg.id)) {
                const task = pending.get(msg.id);
                pending.delete(msg.id);
                if (msg.error) {
                  task.rej(new Error(msg.error.message || "JSON-RPC error"));
                } else {
                  task.res(msg.result);
                }
              } else if (msg && msg.method && msg.params) {
                if (
                  msg.method === "item/agentMessage/delta" &&
                  msg.params.threadId === activeThreadId &&
                  (!activeTurnId || msg.params.turnId === activeTurnId)
                ) {
                  const delta = String(msg.params.delta || "");
                  streamedText += delta;
                  if (onProgress && delta) {
                    onProgress({ type: "delta", text: delta });
                  }
                }
                if (
                  msg.method === "item/reasoning/textDelta" &&
                  msg.params.threadId === activeThreadId &&
                  (!activeTurnId || msg.params.turnId === activeTurnId)
                ) {
                  const reasoningDelta = String(msg.params.delta || "");
                  if (onProgress && reasoningDelta) {
                    onProgress({ type: "reasoning", text: reasoningDelta });
                  }
                }
                if (
                  msg.method === "item/reasoning/summaryTextDelta" &&
                  msg.params.threadId === activeThreadId &&
                  (!activeTurnId || msg.params.turnId === activeTurnId)
                ) {
                  const reasoningSummaryDelta = String(msg.params.delta || "");
                  if (onProgress && reasoningSummaryDelta) {
                    onProgress({ type: "reasoning", text: reasoningSummaryDelta });
                  }
                }
                if (msg.method === "turn/started" && msg.params.threadId === activeThreadId) {
                  if (onProgress) {
                    onProgress({ type: "status", text: "已发送，模型思考中..." });
                  }
                }
                if (msg.method === "item/started" && msg.params.threadId === activeThreadId) {
                  const itemType = msg.params.item && msg.params.item.type ? String(msg.params.item.type) : "";
                  if (onProgress && itemType) {
                    if (itemType === "reasoning") {
                      onProgress({ type: "status", text: "模型正在推理..." });
                    } else if (itemType === "commandExecution" || itemType === "mcpToolCall") {
                      onProgress({ type: "tool", text: "正在调用工具..." });
                    }
                  }
                }
                if (
                  msg.method === "turn/completed" &&
                  msg.params.threadId === activeThreadId &&
                  msg.params.turn &&
                  (!activeTurnId || msg.params.turn.id === activeTurnId) &&
                  turnDone
                ) {
                  if (onProgress) {
                    onProgress({ type: "status", text: "生成完成，正在整理..." });
                  }
                  turnDone.resolve(msg.params.turn);
                }
                if (
                  msg.method === "error" &&
                  msg.params.threadId === activeThreadId &&
                  (!activeTurnId || msg.params.turnId === activeTurnId) &&
                  turnDone
                ) {
                  const em = msg.params.error && msg.params.error.message ? msg.params.error.message : "turn failed";
                  turnDone.reject(new Error(em));
                }
              }
            } catch (error) {
              // Ignore non-JSON lines.
            }
          }
          idx = stdoutBuffer.indexOf("\n");
        }
      });

      (async () => {
        await sendRequest("initialize", {
          clientInfo: { name: "codex-bridge", version: "0.1.0" },
          capabilities: null
        });
        sendNotification("initialized", {});
        if (onProgress) {
          onProgress({ type: "status", text: "已连接 Codex，会话初始化中..." });
        }

        let threadId = session && session.codexThreadId ? session.codexThreadId : "";
        if (threadId) {
          try {
            const resumed = await sendRequest("thread/resume", { threadId });
            threadId = resumed && resumed.thread && resumed.thread.id ? resumed.thread.id : threadId;
          } catch (error) {
            if (onProgress) {
              onProgress({ type: "status", text: "会话恢复失败，已自动回退到历史拼接模式..." });
            }
            threadId = "";
          }
        }

        if (!threadId) {
          const started = await sendRequest("thread/start", {
            cwd,
            model,
            approvalPolicy,
            sandbox: sandboxMode,
            baseInstructions:
              [
                this.settings.chatSystemPrompt || "",
                "你是 Obsidian 内的对话助手。",
                "请直接回答用户消息，不要把正常对话改写成“你想在 vault 做什么”。",
                "除非用户明确要求，否则不要输出技能分流或安装指引。",
                "默认使用中文回答。"
              ]
                .filter(Boolean)
                .join("\n"),
            developerInstructions: null
          });
          threadId = started && started.thread && started.thread.id ? started.thread.id : "";
          if (!threadId) {
            throw new Error("thread/start 未返回 threadId");
          }
        }
        activeThreadId = threadId;
        const listener = await sendRequest("addConversationListener", {
          conversationId: threadId,
          experimentalRawEvents: false
        });
        if (onProgress) {
          onProgress({ type: "status", text: "已建立流式监听，准备生成..." });
        }
        const subscriptionId =
          listener && typeof listener.subscriptionId === "string" ? listener.subscriptionId : "";

        const files = Array.isArray(imagePaths) ? imagePaths.filter(Boolean) : [];
        const turnInput = [
          {
            type: "text",
            text: String(prompt || ""),
            text_elements: []
          },
          ...files.map((fp) => ({ type: "localImage", path: String(fp) }))
        ];

        const turnStart = await sendRequest("turn/start", {
          threadId,
          input: turnInput
        });

        const turnId = turnStart && turnStart.turn && turnStart.turn.id ? turnStart.turn.id : "";
        activeTurnId = turnId;
        const completedTurn = await new Promise((res, rej) => {
          const timer = setTimeout(() => {
            turnDone = null;
            rej(new Error("turn timeout"));
          }, 120000);
          turnDone = {
            resolve: (t) => {
              clearTimeout(timer);
              turnDone = null;
              res(t);
            },
            reject: (e) => {
              clearTimeout(timer);
              turnDone = null;
              rej(e);
            }
          };
        });
        let finalText = streamedText.trim();
        if (!finalText && completedTurn && Array.isArray(completedTurn.items)) {
          finalText = completedTurn.items
            .filter((it) => it && it.type === "agentMessage" && typeof it.text === "string")
            .map((it) => it.text)
            .join("\n")
            .trim();
        }
        if (subscriptionId) {
          try {
            await sendRequest("removeConversationListener", { subscriptionId });
          } catch (error) {
            // ignore listener cleanup errors
          }
        }

        finish({
          text: finalText || "",
          sessionId: session.codexSessionId || "",
          threadId
        });
      })().catch((error) => {
        fail(error);
      });
    });
  }

  runCodexExec(prompt, session, onProgress, imagePaths) {
    if (onProgress) {
      onProgress({ type: "status", text: "使用兼容模式执行中..." });
    }
    const extraArgs = splitArgs(this.settings.codexArgs).filter((arg) => {
      if (!arg || arg === "-" || arg === "--") {
        return false;
      }
      if (arg === "--full-auto") {
        return false;
      }
      return true;
    });
    const selectedModel = this.getSelectedModel() || pickModelFromArgs(splitArgs(this.settings.codexArgs)) || "gpt-5";
    extraArgs.push("-m", selectedModel);
    const isAgent = this.isAgentMode();
    const sandboxMode = isAgent ? "workspace-write" : "read-only";
    const hasSession = Boolean(session && session.codexSessionId);
    const files = Array.isArray(imagePaths) ? imagePaths.filter(Boolean) : [];
    const imageArgs = [];
    for (const fp of files) {
      imageArgs.push("-i", fp);
    }

    const outputFile = path.join(
      os.tmpdir(),
      `obsidian-codex-bridge-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`
    );
    const outputArgs = ["-o", outputFile];
    const args = hasSession
      ? [
          "exec",
          "resume",
          "--skip-git-repo-check",
          ...extraArgs,
          ...imageArgs,
          session.codexSessionId,
          "-"
        ]
      : [
          "exec",
          "--skip-git-repo-check",
          "--color",
          "never",
          "--sandbox",
          sandboxMode,
          ...extraArgs,
          ...imageArgs,
          ...outputArgs
        ];

    return new Promise((resolve, reject) => {
      const child = execFile(this.settings.codexCommand, args, {
        cwd: this.app.vault.adapter.basePath,
        maxBuffer: 10 * 1024 * 1024
      });
      let settled = false;
      const safeResolve = (value) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(value);
      };
      const safeReject = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      };

      this.setActiveRunCanceler(() => {
        try {
          child.kill();
        } catch (error) {
          // ignore
        }
        safeReject(createInterruptedError());
      });

      let stdout = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk || "");
      });

      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk || "");
      });

      child.on("error", (error) => {
        safeReject(error);
      });

      child.on("close", (code) => {
        try {
          const content = outputFile && fs.existsSync(outputFile) ? fs.readFileSync(outputFile, "utf8") : "";
          if (outputFile && fs.existsSync(outputFile)) {
            fs.unlinkSync(outputFile);
          }
          const parsedSessionId = extractSessionId(`${stderr}\n${stdout}`);

          if (code === 0) {
            const text = hasSession ? stdout.trim() : content.trim() || stdout.trim();
            safeResolve({
              text,
              sessionId: parsedSessionId || (session && session.codexSessionId) || ""
            });
            return;
          }

          safeReject(new Error(stderr.trim() || `exit code ${code}`));
        } catch (fileError) {
          safeReject(fileError);
        }
      });

      try {
        child.stdin.write(String(prompt || ""));
      } catch (error) {
      }
      child.stdin.end();
    });
  }
};

function splitArgs(input) {
  if (!input || !input.trim()) {
    return [];
  }

  const args = [];
  const pattern = /\s*(?:"([^"]*)"|'([^']*)'|(\\.|[^\s"'])+)/g;
  let match;
  while ((match = pattern.exec(input)) !== null) {
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    args.push(value.replace(/\\([\\"'\s])/g, "$1"));
  }
  return args;
}

function pickModelFromArgs(args) {
  if (!Array.isArray(args)) {
    return "";
  }
  for (let i = 0; i < args.length; i += 1) {
    const item = args[i];
    if (item === "-m" || item === "--model") {
      return args[i + 1] || "";
    }
    if (typeof item === "string" && item.startsWith("--model=")) {
      return item.slice("--model=".length);
    }
  }
  return "";
}

function createInterruptedError() {
  const error = new Error("已中断");
  error.code = "INTERRUPTED";
  return error;
}

function isInterruptedError(error) {
  if (!error) {
    return false;
  }
  if (error.code === "INTERRUPTED") {
    return true;
  }
  const message = typeof error.message === "string" ? error.message : "";
  return message.includes("已中断");
}

function safeSetIcon(el, iconName, fallbackText) {
  if (!el) {
    return;
  }
  el.empty();
  if (typeof setIcon === "function") {
    try {
      setIcon(el, iconName);
      return;
    } catch (error) {
      // Fallback to text when icon rendering is not available in current Obsidian runtime.
    }
  }
  if (fallbackText) {
    el.setText(fallbackText);
  }
}

function indentText(text, spaces) {
  const pad = " ".repeat(Math.max(0, spaces || 0));
  return String(text || "")
    .split("\n")
    .map((line) => `${pad}${line}`)
    .join("\n");
}

function normalizeMentionEntry(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const type = raw.type === "folder" ? "folder" : "file";
  const path = String(raw.path || "").trim().replace(/\/+$/, type === "folder" ? "" : "");
  if (!path) {
    return null;
  }
  const name = String(raw.name || (type === "folder" ? path.split("/").pop() || path : path)).trim() || path;
  return {
    type,
    path,
    name,
    auto: Boolean(raw.auto)
  };
}

function normalizeMentionEntries(list) {
  const source = Array.isArray(list) ? list : [];
  const map = new Map();
  for (const item of source) {
    const ref = normalizeMentionEntry(item);
    if (!ref) {
      continue;
    }
    const key = `${ref.type}:${ref.path}`;
    if (!map.has(key)) {
      map.set(key, ref);
    }
  }
  return [...map.values()];
}

function formatOneMentionRefForPrompt(ref, index, keepEmpty) {
  const item = ref && typeof ref === "object" ? ref : {};
  const type = item.type === "folder" ? "folder" : "file";
  const i = Number.isFinite(index) ? index + 1 : 1;
  const text = String(item.text || "");
  if (type === "folder") {
    return `文件夹${i}路径: ${item.path || "unknown"}\n文件夹${i}内容:\n${text || (keepEmpty ? "" : "(空)")}`;
  }
  return `文档${i}路径: ${item.path || "unknown"}\n文档${i}内容:\n${text || (keepEmpty ? "" : "(空)")}`;
}

function formatMentionRefsForPrompt(refs, keepEmpty) {
  const list = Array.isArray(refs) ? refs : [];
  return list.map((r, i) => formatOneMentionRefForPrompt(r, i, keepEmpty)).join("\n\n");
}

function hasMentionRefText(refs) {
  if (!Array.isArray(refs) || !refs.length) {
    return false;
  }
  return refs.some((r) => /\S/.test(String((r && r.text) || "")));
}

function normalizeSkillIds(list) {
  if (!Array.isArray(list)) {
    return [];
  }
  const seen = new Set();
  const result = [];
  for (const item of list) {
    const id = String(item || "").trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    result.push(id);
  }
  return result.slice(0, MAX_SKILLS_PER_SESSION);
}

function shortSkillNameFromId(id) {
  const text = String(id || "");
  if (!text) {
    return "skill";
  }
  const noPrefix = text.includes(":") ? text.slice(text.indexOf(":") + 1) : text;
  const parts = noPrefix.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : noPrefix;
}

function extractSkillDescription(markdown) {
  const text = String(markdown || "");
  if (!text.trim()) {
    return "";
  }
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("```")) {
      continue;
    }
    return line.slice(0, 140);
  }
  return "";
}

function scanSkillCatalog(root, label) {
  const rootPath = String(root || "");
  if (!rootPath || !fs.existsSync(rootPath)) {
    return [];
  }
  const skipDirNames = new Set([
    "node_modules",
    ".git",
    ".hg",
    ".svn",
    "dist",
    "build",
    "target",
    "__pycache__"
  ]);
  const items = [];
  const stack = [rootPath];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      continue;
    }
    let skillFileName = "";
    for (const entry of entries) {
      if (!entry || !entry.name) {
        continue;
      }
      if (entry.isFile() && entry.name.toUpperCase() === "SKILL.MD") {
        skillFileName = entry.name;
        break;
      }
    }
    if (skillFileName) {
      const skillFile = path.join(dir, skillFileName);
      let body = "";
      try {
        body = fs.readFileSync(skillFile, "utf8");
      } catch (error) {
        body = "";
      }
      const relDir = path.relative(rootPath, dir).replace(/\\/g, "/");
      const id = `${label}:${relDir || "."}`;
      const name = path.basename(dir) || shortSkillNameFromId(id);
      items.push({
        id,
        name,
        path: skillFile,
        description: extractSkillDescription(body),
        body: clampText(body, MAX_SKILL_SNIPPET_CHARS)
      });
      continue;
    }
    for (const entry of entries) {
      if (!entry || !entry.isDirectory()) {
        continue;
      }
      if (skipDirNames.has(entry.name)) {
        continue;
      }
      if (entry.name.startsWith(".") && entry.name !== ".system") {
        continue;
      }
      {
        stack.push(path.join(dir, entry.name));
      }
    }
  }
  return items;
}

function formatSkillRefsForPrompt(skills) {
  const list = Array.isArray(skills) ? skills : [];
  if (!list.length) {
    return "";
  }
  const lines = ["已启用 Skills（按以下技能规则执行）:"];
  list.forEach((skill, idx) => {
    lines.push(`${idx + 1}. ${skill.name || shortSkillNameFromId(skill.id)} (${skill.id || "unknown"})`);
    if (skill.description) {
      lines.push(`   描述: ${skill.description}`);
    }
    if (skill.body) {
      lines.push(`   SKILL.md 摘要:\n${indentText(skill.body, 3)}`);
    }
  });
  return lines.join("\n");
}

function shouldAttachDocContext(userInput, hasRefs) {
  if (hasRefs) {
    return true;
  }
  const text = String(userInput || "").toLowerCase();
  if (!text) {
    return false;
  }
  const docWords = [
    "文档",
    "本文",
    "这篇",
    "这份",
    "当前文档",
    "当前笔记",
    "笔记",
    "article",
    "note",
    "this doc",
    "this note"
  ];
  const taskWords = [
    "总结",
    "概述",
    "提炼",
    "摘要",
    "改写",
    "润色",
    "重写",
    "分析",
    "解释",
    "翻译",
    "提取",
    "抽取",
    "对比",
    "比较",
    "整理",
    "生成",
    "summarize",
    "summary",
    "rewrite",
    "polish",
    "analyze",
    "explain",
    "translate",
    "extract",
    "compare"
  ];
  return docWords.some((w) => text.includes(w)) || taskWords.some((w) => text.includes(w));
}

function rewriteShortChatIntent(input) {
  const text = String(input || "").trim();
  if (!text) {
    return "";
  }
  const normalized = text.toLowerCase();
  const greetingPattern = /^(你好|您好|嗨|哈喽|hello|hi|hey)[!！,.。 ]*$/i;
  const whoPattern = /^(你是谁|你是什么模型|what are you|who are you)[?？!！ ]*$/i;
  const capabilityPattern = /^(你能做什么|你可以做什么|help|帮助|能帮我什么)[?？!！ ]*$/i;

  if (greetingPattern.test(normalized)) {
    return [
      "你是 Obsidian 里的中文助手。",
      "用户在打招呼，请直接用中文友好回复一句，并简要说明你可以做的三件事：",
      "1) 总结当前文档",
      "2) 基于 @[[文档路径]] 回答",
      "3) 改写/提炼当前文档",
      "不要说误触按键，不要转成技能分流。",
      `用户原话: ${text}`
    ].join("\n");
  }

  if (whoPattern.test(normalized)) {
    return [
      "你是 Obsidian 里的 Codex 助手。",
      "请直接用中文回答你是谁，并说明你在当前插件中的作用。",
      "不要说误触按键，不要转成技能分流。",
      `用户原话: ${text}`
    ].join("\n");
  }

  if (capabilityPattern.test(normalized)) {
    return [
      "请用中文直接列出你能帮用户做的事项（3-6条），结合当前文档工作流。",
      "不要说误触按键，不要转成技能分流。",
      `用户原话: ${text}`
    ].join("\n");
  }

  return "";
}

function detectDocIntent(input) {
  const text = String(input || "").trim().toLowerCase();
  if (!text) {
    return "";
  }

  const summaryWords = ["总结", "概述", "提炼", "摘要", "总结一下", "summarize", "summary"];
  const rewriteWords = ["改写", "润色", "重写", "优化", "rewrite", "polish"];
  const docWords = [
    "文档",
    "本文",
    "这篇",
    "这份",
    "当前文档",
    "当前笔记",
    "笔记",
    "article",
    "note",
    "this doc",
    "this note"
  ];
  const docTaskWords = [
    "分析",
    "解释",
    "问答",
    "回答",
    "翻译",
    "提取",
    "抽取",
    "对比",
    "比较",
    "结构化",
    "整理",
    "优化",
    "改成",
    "生成",
    "qa",
    "analyze",
    "explain",
    "translate",
    "extract",
    "compare"
  ];

  const isSummary = summaryWords.some((w) => text.includes(w));
  const isRewrite = rewriteWords.some((w) => text.includes(w));
  const mentionDoc = docWords.some((w) => text.includes(w));
  const isDocTask = docTaskWords.some((w) => text.includes(w));

  if (isSummary && mentionDoc) {
    return "文档总结";
  }
  if (isRewrite && mentionDoc) {
    return "文档改写";
  }
  if (mentionDoc || isDocTask) {
    return "文档任务";
  }
  return "";
}

function formatConversationHistory(session, currentUserInput) {
  if (!session || !Array.isArray(session.messages) || !session.messages.length) {
    return "";
  }
  const normalizedCurrent = String(currentUserInput || "").trim();
  let messages = session.messages.filter(
    (msg) =>
      msg &&
      (msg.role === "user" || msg.role === "assistant") &&
      typeof msg.content === "string" &&
      msg.content.trim()
  );
  if (!messages.length) {
    return "";
  }

  const last = messages[messages.length - 1];
  if (last && last.role === "user" && last.content.trim() === normalizedCurrent) {
    messages = messages.slice(0, -1);
  }
  if (!messages.length) {
    return "";
  }

  const recent = messages.slice(-6).map((msg) => {
    const roleName = msg.role === "assistant" ? "助手" : "用户";
    const text = msg.content.trim().replace(/\s+\n/g, "\n");
    const clipped = text.length > 700 ? `${text.slice(0, 700)}\n...(已截断)` : text;
    return `${roleName}:\n${clipped}`;
  });

  return `最近对话历史（按时间顺序）:\n${recent.join("\n\n")}`;
}

function formatCompactConversationHistory(session, currentUserInput, maxTurns, maxChars) {
  if (!session || !Array.isArray(session.messages) || !session.messages.length) {
    return "";
  }
  const normalizedCurrent = String(currentUserInput || "").trim();
  let messages = session.messages.filter(
    (msg) =>
      msg &&
      (msg.role === "user" || msg.role === "assistant") &&
      typeof msg.content === "string" &&
      msg.content.trim()
  );
  if (!messages.length) {
    return "";
  }
  const last = messages[messages.length - 1];
  if (last && last.role === "user" && last.content.trim() === normalizedCurrent) {
    messages = messages.slice(0, -1);
  }
  if (!messages.length) {
    return "";
  }
  const limitTurns = Number.isFinite(maxTurns) ? Math.max(1, maxTurns) : 4;
  const limitChars = Number.isFinite(maxChars) ? Math.max(80, maxChars) : 260;
  const recent = messages.slice(-limitTurns).map((msg) => {
    const role = msg.role === "assistant" ? "助手" : "用户";
    const text = msg.content.trim().replace(/\s+/g, " ");
    const clipped = text.length > limitChars ? `${text.slice(0, limitChars)}...` : text;
    return `${role}: ${clipped}`;
  });
  return `会话记忆:\n${recent.join("\n")}`;
}

function formatConversationHistoryWithBudget(
  session,
  currentUserInput,
  maxTurns,
  maxTotalChars,
  maxPerMessageChars
) {
  if (!session || !Array.isArray(session.messages) || !session.messages.length) {
    return "";
  }
  const normalizedCurrent = String(currentUserInput || "").trim();
  let messages = session.messages.filter(
    (msg) =>
      msg &&
      (msg.role === "user" || msg.role === "assistant") &&
      typeof msg.content === "string" &&
      msg.content.trim()
  );
  if (!messages.length) {
    return "";
  }
  const last = messages[messages.length - 1];
  if (last && last.role === "user" && last.content.trim() === normalizedCurrent) {
    messages = messages.slice(0, -1);
  }
  if (!messages.length) {
    return "";
  }

  const turnLimit = Number.isFinite(maxTurns) ? Math.max(1, maxTurns) : 20;
  const totalLimit = Number.isFinite(maxTotalChars) ? Math.max(2000, maxTotalChars) : 60000;
  const oneLimit = Number.isFinite(maxPerMessageChars) ? Math.max(300, maxPerMessageChars) : 8000;
  const picked = [];
  let total = 0;
  for (let i = messages.length - 1; i >= 0 && picked.length < turnLimit; i -= 1) {
    const msg = messages[i];
    const role = msg.role === "assistant" ? "助手" : "用户";
    const raw = msg.content.trim();
    const clipped = raw.length > oneLimit ? `${raw.slice(0, oneLimit)}\n...(已截断)` : raw;
    const block = `${role}:\n${clipped}`;
    const next = total + block.length + 2;
    if (picked.length > 0 && next > totalLimit) {
      break;
    }
    picked.push(block);
    total = next;
  }
  if (!picked.length) {
    return "";
  }
  picked.reverse();
  return `会话记忆（最近优先，预算${totalLimit}字符）:\n${picked.join("\n\n")}`;
}

function getLastAssistantMessage(session, currentUserInput, maxChars) {
  if (!session || !Array.isArray(session.messages) || !session.messages.length) {
    return "";
  }
  const normalizedCurrent = String(currentUserInput || "").trim();
  let messages = session.messages.filter(
    (msg) =>
      msg &&
      (msg.role === "user" || msg.role === "assistant") &&
      typeof msg.content === "string" &&
      msg.content.trim()
  );
  if (!messages.length) {
    return "";
  }
  const last = messages[messages.length - 1];
  if (last && last.role === "user" && last.content.trim() === normalizedCurrent) {
    messages = messages.slice(0, -1);
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg && msg.role === "assistant" && typeof msg.content === "string" && msg.content.trim()) {
      const limit = Number.isFinite(maxChars) ? Math.max(400, maxChars) : 4000;
      return clampText(msg.content.trim(), limit);
    }
  }
  return "";
}

function shouldCarryForwardLastAssistant(input) {
  const text = String(input || "").trim().toLowerCase();
  if (!text) {
    return false;
  }
  const referWords = [
    "上文",
    "上一条",
    "刚才",
    "前面",
    "上述",
    "之前",
    "刚刚",
    "总结的内容",
    "上一步",
    "that summary",
    "previous answer",
    "last answer",
    "previous result",
    "above"
  ];
  const actionWords = [
    "覆盖",
    "写入",
    "替换",
    "保存",
    "放到",
    "写到",
    "粘贴到",
    "apply",
    "overwrite",
    "replace",
    "write"
  ];
  const hasRef = referWords.some((w) => text.includes(w));
  const hasAction = actionWords.some((w) => text.includes(w));
  return hasRef || (text.includes("总结") && hasAction);
}

function clampText(text, maxLen) {
  if (!text) {
    return "";
  }
  return text.length > maxLen ? `${text.slice(0, maxLen)}\n...(truncated)` : text;
}

function estimateTextTokens(text) {
  const raw = String(text || "");
  if (!raw) {
    return 0;
  }
  const bytes = Buffer.byteLength(raw, "utf8");
  return Math.max(1, Math.ceil(bytes / 3));
}

function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeSession(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const messages = Array.isArray(raw.messages)
    ? raw.messages
        .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .map((m) => {
          const wasPending = Boolean(m.pending);
          const rawContent = typeof m.content === "string" ? m.content : "";
          const trimmed = rawContent.trim();
          if (
            wasPending &&
            (!trimmed || trimmed === "(处理中...)" || trimmed === "（上次会话未完成，已中断）")
          ) {
            return null;
          }
          if (m.role === "assistant" && trimmed === "（上次会话未完成，已中断）") {
            return null;
          }
          return {
            role: m.role,
            content: rawContent,
            thought: typeof m.thought === "string" ? m.thought : "",
            thoughtDurationMs: Number.isFinite(m.thoughtDurationMs) ? Number(m.thoughtDurationMs) : 0,
            thoughtLabel:
              typeof m.thoughtLabel === "string" && m.thoughtLabel
                ? m.thoughtLabel
                : wasPending
                  ? "Interrupted"
                  : "",
            thoughtExpanded: Boolean(m.thoughtExpanded),
            pending: false,
            pendingId: ""
          };
        })
        .filter(Boolean)
    : [];

  return {
    id: String(raw.id || newId()),
    title: String(raw.title || "新对话"),
    createdAt: Number(raw.createdAt || Date.now()),
    updatedAt: Number(raw.updatedAt || Date.now()),
    messages,
    codexSessionId: typeof raw.codexSessionId === "string" ? raw.codexSessionId : "",
    codexThreadId: typeof raw.codexThreadId === "string" ? raw.codexThreadId : "",
    draftMentions: normalizeMentionEntries(raw.draftMentions || []),
    draftSkills: normalizeSkillIds(raw.draftSkills || []),
    compactedContext: clampText(typeof raw.compactedContext === "string" ? raw.compactedContext : "", MAX_COMPACT_SUMMARY_CHARS),
    lastPromptTokens: Number.isFinite(raw.lastPromptTokens) ? Number(raw.lastPromptTokens) : 0,
    autoDocMentionDisabled: Boolean(raw.autoDocMentionDisabled),
    autoDocMentionSeeded: Boolean(raw.autoDocMentionSeeded)
  };
}

function extractSessionId(text) {
  const source = String(text || "");
  const patterns = [
    /session id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
    /session_id["'\s:=]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
    /"sessionId"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }
  return "";
}

function looksLikeRoutingReply(text) {
  const source = String(text || "").toLowerCase();
  if (!source) {
    return false;
  }
  return (
    source.includes("stray key") ||
    source.includes("stray keystroke") ||
    source.includes("skill-creator") ||
    source.includes("skill-installer") ||
    (source.includes("what do you want to do in") && source.includes("vault"))
  );
}

function trimSessionMessages(session) {
  if (!session || !Array.isArray(session.messages)) {
    return;
  }
  if (session.messages.length > MAX_SESSION_MESSAGES) {
    session.messages = session.messages.slice(-MAX_SESSION_MESSAGES);
  }
}
