import { useEffect, useRef, useState } from "react";
import { ApiError, getProjectReadme, saveProjectReadme } from "../api";
import { useTaskboardI18n } from "../i18n";
import type { ActorIdentity, Project, ProjectReadme } from "../types";
import { LinearIcon } from "./LinearIcon";
import { MarkdownDocument } from "./MarkdownDocument";
import { EditIcon, PlusIcon } from "./SemanticIcons";
import "./ProjectReadmeView.css";

interface ProjectReadmeViewProps {
  project: Project;
  currentUser: ActorIdentity;
  revision: number;
  onError?: (error: string) => void;
}

export function ProjectReadmeView({
  project,
  currentUser: _currentUser,
  revision,
  onError,
}: ProjectReadmeViewProps) {
  const { language, text } = useTaskboardI18n();
  const [readme, setReadme] = useState<ProjectReadme | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadRequest, setLoadRequest] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draftContent, setDraftContent] = useState("");
  const [editTab, setEditTab] = useState<"write" | "preview">("write");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) return;
    let active = true;
    setSaveError(null);
    setLoadError(null);

    getProjectReadme(project.id)
      .then((data) => {
        if (!active) return;
        setReadme(data);
        setDraftContent(data.content);
      })
      .catch((err) => {
        if (!active) return;
        const msg = err instanceof Error ? err.message : String(err);
        setLoadError(msg);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [editing, loadRequest, project.id, revision]);

  function handleStartEditing() {
    if (!readme) return;
    setDraftContent(readme.content);
    setEditing(true);
    setEditTab("write");
    setSaveError(null);
    setTimeout(() => {
      textareaRef.current?.focus();
    }, 50);
  }

  function handleCancelEditing() {
    setEditing(false);
    setDraftContent(readme?.content ?? "");
    setSaveError(null);
  }

  async function handleSave() {
    if (saving || !readme) return;
    setSaving(true);
    setSaveError(null);

    try {
      const updated = await saveProjectReadme(
        project.id,
        draftContent,
        readme.version,
      );
      setReadme(updated);
      setDraftContent(updated.content);
      setEditing(false);
    } catch (err) {
      if (err instanceof ApiError && err.code === "VERSION_CONFLICT") {
        setSaveError(
          text(
            "项目说明已被其他协作者或 Agent 更新，请刷新后重试。",
            "Project README was modified elsewhere. Please refresh and try again.",
          ),
        );
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        setSaveError(msg);
        onError?.(msg);
      }
    } finally {
      setSaving(false);
    }
  }

  const hasContent = Boolean(readme?.content && readme.content.trim().length > 0);

  if (loading) {
    return (
      <div className="project-readme-loading">
        <div className="project-readme-spinner" />
        <p>{text("正在加载 Readme…", "Loading Readme…")}</p>
      </div>
    );
  }

  if (loadError && !readme) {
    return (
      <div className="project-readme-loading" role="alert">
        <p>{loadError}</p>
        <button
          type="button"
          className="button secondary"
          onClick={() => {
            setLoading(true);
            setLoadRequest((current) => current + 1);
          }}
        >
          {text("重试", "Try again")}
        </button>
      </div>
    );
  }

  return (
    <div className="project-readme-container">
      <div className="project-readme-header">
        <div className="project-readme-title-group">
          <span className="project-readme-icon" aria-hidden="true">
            <LinearIcon name="file" />
          </span>
          <div className="project-readme-title-info">
            <h1 className="project-readme-heading">
              Readme
            </h1>
            <div className="project-readme-meta">
              <span className="project-readme-project-badge">{project.name}</span>
              {readme?.updatedAt && (
                <span className="project-readme-timestamp">
                  {text("更新于", "Updated at")}{" "}
                  {new Date(readme.updatedAt).toLocaleDateString(
                    language === "zh" ? "zh-CN" : "en-US",
                    {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    },
                  )}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="project-readme-actions">
          {!editing ? (
            <button
              type="button"
              className="button secondary project-readme-edit-btn"
              onClick={handleStartEditing}
            >
              <EditIcon color="currentColor" />
              <span>{hasContent ? text("编辑 Readme", "Edit Readme") : text("编写 Readme", "Write Readme")}</span>
            </button>
          ) : (
            <div className="project-readme-edit-actions">
              <div className="project-readme-tab-toggle" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={editTab === "write"}
                  className={`project-readme-tab${editTab === "write" ? " is-active" : ""}`}
                  onClick={() => setEditTab("write")}
                >
                  <EditIcon color="currentColor" />
                  <span>{text("编辑", "Write")}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={editTab === "preview"}
                  className={`project-readme-tab${editTab === "preview" ? " is-active" : ""}`}
                  onClick={() => setEditTab("preview")}
                >
                  <LinearIcon name="file" />
                  <span>{text("预览", "Preview")}</span>
                </button>
              </div>

              <button
                type="button"
                className="button ghost"
                disabled={saving}
                onClick={handleCancelEditing}
              >
                {text("取消", "Cancel")}
              </button>

              <button
                type="button"
                className="button primary"
                disabled={saving}
                onClick={() => void handleSave()}
              >
                {saving ? text("保存中…", "Saving…") : text("保存", "Save")}
              </button>
            </div>
          )}
        </div>
      </div>

      {saveError && (
        <div className="project-readme-alert error" role="alert">
          <LinearIcon name="alert" />
          <span>{saveError}</span>
        </div>
      )}

      {loadError && !editing && (
        <div className="project-readme-alert error" role="alert">
          <LinearIcon name="alert" />
          <span>{loadError}</span>
          <button
            type="button"
            className="button secondary"
            onClick={() => {
              setLoading(true);
              setLoadRequest((current) => current + 1);
            }}
          >
            {text("重试", "Try again")}
          </button>
        </div>
      )}

      {editing ? (
        <div className="project-readme-editor-wrapper">
          {editTab === "write" ? (
            <div className="project-readme-textarea-wrapper">
              <textarea
                ref={textareaRef}
                className="project-readme-textarea"
                value={draftContent}
                onChange={(e) => setDraftContent(e.target.value)}
                placeholder={text(
                  "输入项目 Readme 内容，支持 Markdown 语法…",
                  "Enter project Readme content in Markdown…",
                )}
                aria-label={text("项目 Readme 内容", "Project Readme content")}
                rows={24}
              />
              <div className="project-readme-editor-footer">
                <span className="project-readme-char-count">
                  {text(`${draftContent.length} 字符`, `${draftContent.length} characters`)}
                </span>
                <span className="project-readme-tip">
                  {text("💡 提示：更详细的多页文档建议放置于项目本地 docs/ 目录", "💡 Tip: Detailed multi-page docs belong in the local docs/ directory")}
                </span>
              </div>
            </div>
          ) : (
            <div className="project-readme-preview-wrapper markdown-preview-surface">
              {draftContent.trim() ? (
                <MarkdownDocument value={draftContent} />
              ) : (
                <p className="project-readme-preview-empty">
                  {text("暂无预览内容", "No content to preview")}
                </p>
              )}
            </div>
          )}
        </div>
      ) : hasContent ? (
        <div className="project-readme-content-wrapper markdown-preview-surface">
          <MarkdownDocument value={readme?.content ?? ""} />
        </div>
      ) : (
        <div className="project-readme-empty-state">
          <div className="project-readme-empty-icon">
            <LinearIcon name="file" />
          </div>
          <h2 className="project-readme-empty-title">
            {text("项目暂无 Readme", "No Readme for this project yet")}
          </h2>
          <p className="project-readme-empty-desc">
            {text(
              "为项目撰写全局 Readme，记录项目目标、技术栈、架构与规范，方便团队协作者与 Agent 快速上手。",
              "Create a project Readme to document goals, architecture, tech stack, and conventions for collaborators and AI agents.",
            )}
          </p>
          <button
            type="button"
            className="button primary project-readme-create-btn"
            onClick={handleStartEditing}
          >
            <PlusIcon color="currentColor" size={16} />
            <span>{text("开始编写 Readme", "Create Project Readme")}</span>
          </button>
        </div>
      )}
    </div>
  );
}
