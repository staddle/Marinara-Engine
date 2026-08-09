import { useEffect, useState } from "react";
import { Copy, Maximize2, RotateCcw, Save, Trash2, X } from "lucide-react";
import {
  DEFAULT_IMPERSONATE_PROMPT,
  EMPTY_IMPERSONATE_PROMPT_TEMPLATE_CATALOG,
  IMPERSONATE_PROMPT_TEMPLATE_MAX_NAME_LENGTH,
} from "@marinara-engine/shared";
import { useTranslation as useUiTranslation } from "react-i18next";
import { ExpandedTextarea } from "../../../components/ui/ExpandedTextarea";
import { HelpTooltip } from "../../../components/ui/HelpTooltip";
import {
  showImpersonatePromptTemplateValidationError,
  useIsSavingImpersonatePromptTemplates,
  useImpersonatePromptTemplates,
  useSaveImpersonatePromptTemplates,
  validateImpersonatePromptTemplates,
} from "../../../hooks/use-impersonate-prompt-templates";
import { showConfirmDialog } from "../../../lib/app-dialogs";
import { cn, generateClientId } from "../../../lib/utils";
import { useUIStore } from "../../../stores/ui.store";

export function ImpersonatePromptTemplateField() {
  const { t: localizeUi } = useUiTranslation();
  const promptTemplate = useUIStore((state) => state.impersonatePromptTemplate);
  const setPromptTemplate = useUIStore((state) => state.setImpersonatePromptTemplate);
  const activePromptTemplateId = useUIStore((state) => state.activeImpersonatePromptTemplateId);
  const selectPromptTemplate = useUIStore((state) => state.selectImpersonatePromptTemplate);
  const clearActivePromptTemplate = useUIStore((state) => state.clearActiveImpersonatePromptTemplate);
  const promptTemplatesQuery = useImpersonatePromptTemplates();
  const savePromptTemplates = useSaveImpersonatePromptTemplates();
  const promptTemplateCatalogMutationPending = useIsSavingImpersonatePromptTemplates();
  const promptTemplateCatalogReady = promptTemplatesQuery.isSuccess;
  const promptTemplateCatalogBusy =
    !promptTemplateCatalogReady || promptTemplatesQuery.isFetching || promptTemplateCatalogMutationPending;
  const promptTemplateCatalog = promptTemplatesQuery.data ?? EMPTY_IMPERSONATE_PROMPT_TEMPLATE_CATALOG;
  const promptTemplates = promptTemplateCatalog.templates;
  const hasPromptTemplate = promptTemplate.trim().length > 0;
  const activePromptTemplate = promptTemplates.find((template) => template.id === activePromptTemplateId) ?? null;
  const promptIsDirty = activePromptTemplate ? promptTemplate !== activePromptTemplate.prompt : hasPromptTemplate;
  const hasStandaloneDraft = !activePromptTemplate && hasPromptTemplate;
  const usingBuiltInDefault = !activePromptTemplate && !hasStandaloneDraft;
  const displayedPromptTemplate = usingBuiltInDefault ? DEFAULT_IMPERSONATE_PROMPT : promptTemplate;
  const [promptEditorExpanded, setPromptEditorExpanded] = useState(false);
  const [templateNameDraft, setTemplateNameDraft] = useState<string | null>(null);
  const saveAsPending = savePromptTemplates.isPending && templateNameDraft !== null;

  useEffect(() => {
    if (
      promptTemplateCatalogReady &&
      activePromptTemplateId &&
      !promptTemplates.some((template) => template.id === activePromptTemplateId)
    ) {
      clearActivePromptTemplate();
    }
  }, [activePromptTemplateId, clearActivePromptTemplate, promptTemplateCatalogReady, promptTemplates]);

  const handleSelectPromptTemplate = async (nextId: string | null) => {
    if (!promptTemplateCatalogReady || promptTemplateCatalogBusy) return;
    if (nextId === activePromptTemplateId && !(nextId === null && hasStandaloneDraft)) return;
    if (promptIsDirty) {
      const confirmed = await showConfirmDialog({
        title: localizeUi("ui.chatSettings.impersonatesection.discardUnsavedPromptChanges"),
        message: localizeUi("ui.chatSettings.impersonatesection.switchingTemplatesWillReplaceTheCurrentUnsavedPrompt"),
        confirmLabel: localizeUi("ui.chatSettings.impersonatesection.discardAndSwitch"),
        cancelLabel: localizeUi("ui.chatSettings.impersonatesection.cancel"),
      });
      if (!confirmed) return;
    }
    const nextTemplate = nextId ? (promptTemplates.find((template) => template.id === nextId) ?? null) : null;
    selectPromptTemplate(nextTemplate);
    setTemplateNameDraft(null);
  };

  const handleStartStandalonePrompt = () => {
    if (!usingBuiltInDefault || saveAsPending) return;
    setPromptTemplate(DEFAULT_IMPERSONATE_PROMPT);
  };

  const handleSavePromptTemplate = async () => {
    if (
      !promptTemplateCatalogReady ||
      promptTemplateCatalogBusy ||
      !activePromptTemplate ||
      !hasPromptTemplate ||
      !promptIsDirty
    ) {
      return;
    }
    const nextTemplates = promptTemplates.map((template) =>
      template.id === activePromptTemplate.id ? { ...template, prompt: promptTemplate } : template,
    );
    const validationError = validateImpersonatePromptTemplates(nextTemplates);
    if (validationError) {
      showImpersonatePromptTemplateValidationError(validationError);
      return;
    }
    try {
      await savePromptTemplates.mutateAsync(nextTemplates);
    } catch {
      // The mutation owns the localized error toast; keep the working draft unchanged.
    }
  };

  const handleStartSaveAs = () => {
    if (!promptTemplateCatalogReady || promptTemplateCatalogBusy) return;
    setTemplateNameDraft(
      localizeUi("ui.chatSettings.impersonatesection.templateValue1", {
        value1: promptTemplates.length + 1,
      }),
    );
  };

  const handleSaveAsPromptTemplate = async () => {
    if (!promptTemplateCatalogReady || promptTemplateCatalogBusy || saveAsPending || templateNameDraft === null) return;
    const name = templateNameDraft.trim();
    if (!name || !displayedPromptTemplate.trim()) return;
    const template = {
      id: generateClientId(),
      name,
      prompt: displayedPromptTemplate,
    };
    const nextTemplates = [...promptTemplates, template];
    const validationError = validateImpersonatePromptTemplates(nextTemplates);
    if (validationError) {
      showImpersonatePromptTemplateValidationError(validationError);
      return;
    }
    try {
      await savePromptTemplates.mutateAsync(nextTemplates);
      selectPromptTemplate(template);
      setTemplateNameDraft(null);
    } catch {
      // The mutation owns the localized error toast; keep the draft and dialog open.
    }
  };

  const handleDeletePromptTemplate = async () => {
    if (!promptTemplateCatalogReady || promptTemplateCatalogBusy || !activePromptTemplate) return;
    const confirmed = await showConfirmDialog({
      title: localizeUi("ui.chatSettings.impersonatesection.deleteValue1", {
        value1: activePromptTemplate.name,
      }),
      message: promptIsDirty
        ? localizeUi("ui.chatSettings.impersonatesection.deleteDirtyTemplateWarning")
        : localizeUi("ui.chatSettings.impersonatesection.thisRemovesTheSavedTemplateTheBuiltInDefaultRemains"),
      confirmLabel: localizeUi("ui.chatSettings.impersonatesection.delete"),
      cancelLabel: localizeUi("ui.chatSettings.impersonatesection.cancel"),
      tone: "destructive",
    });
    if (!confirmed) return;
    try {
      await savePromptTemplates.mutateAsync(
        promptTemplates.filter((template) => template.id !== activePromptTemplate.id),
      );
      setTemplateNameDraft(null);
    } catch {
      // The mutation owns the localized error toast; preserve the saved selection and draft.
    }
  };

  const handleResetPromptDraft = () => {
    if (promptTemplateCatalogMutationPending) return;
    setPromptTemplate(activePromptTemplate?.prompt ?? "");
    setTemplateNameDraft(null);
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="text-xs font-semibold">
            {localizeUi("ui.chatSettings.impersonatesection.promptTemplate")}
          </span>
          <HelpTooltip
            text={localizeUi("ui.chatSettings.impersonatesection.optionalGlobalInstructionSentToTheModelWhenYou")}
          />
        </div>
        <select
          value={hasStandaloneDraft ? "__unsaved__" : (activePromptTemplateId ?? "")}
          disabled={promptTemplateCatalogBusy}
          onChange={(event) => {
            void handleSelectPromptTemplate(event.target.value || null);
          }}
          className="min-w-0 max-w-[55%] rounded-lg bg-[var(--secondary)] px-2 py-1 text-[0.6875rem] font-medium text-[var(--foreground)] outline-none ring-1 ring-[var(--border)] focus:ring-2 focus:ring-[var(--ring)]"
          aria-label={localizeUi("ui.chatSettings.impersonatesection.activePromptTemplate")}
        >
          <option value="">{localizeUi("ui.chatSettings.impersonatesection.builtInDefault")}</option>
          {hasStandaloneDraft && (
            <option value="__unsaved__" disabled>
              {localizeUi("ui.chatSettings.impersonatesection.unsavedPrompt")}
            </option>
          )}
          {promptTemplates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name}
              {template.id === activePromptTemplateId && promptIsDirty
                ? localizeUi("ui.chatSettings.impersonatesection.unsavedSuffix")
                : ""}
            </option>
          ))}
        </select>
      </div>
      <div className="relative">
        <textarea
          value={displayedPromptTemplate}
          onChange={(event) => setPromptTemplate(event.target.value)}
          readOnly={usingBuiltInDefault || saveAsPending}
          placeholder={localizeUi("ui.chatSettings.impersonatesection.emptyUseChatBuiltInDefault")}
          rows={4}
          className={cn(
            "min-h-20 w-full resize-y rounded-lg bg-[var(--secondary)] px-3 py-1.5 pr-8 font-mono text-xs leading-relaxed outline-none ring-1 ring-transparent transition-shadow focus:ring-[var(--primary)]/40",
            usingBuiltInDefault && "cursor-text text-[var(--muted-foreground)]",
          )}
        />
        <button
          type="button"
          aria-label={localizeUi("ui.chatSettings.impersonatesection.expandPromptTemplateEditor")}
          onClick={() => setPromptEditorExpanded(true)}
          className="absolute right-1.5 top-1.5 rounded p-1 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
          title={localizeUi("ui.chatSettings.impersonatesection.expandEditor")}
        >
          <Maximize2 size="0.75rem" />
        </button>
      </div>
      <ExpandedTextarea
        open={promptEditorExpanded}
        onClose={() => setPromptEditorExpanded(false)}
        title={localizeUi("ui.chatSettings.impersonatesection.promptTemplate")}
        value={displayedPromptTemplate}
        onChange={setPromptTemplate}
        readOnly={usingBuiltInDefault || saveAsPending}
        placeholder={localizeUi("ui.chatSettings.impersonatesection.emptyUseChatBuiltInDefault")}
        closeLabel={localizeUi("ui.chatSettings.impersonatesection.collapsePromptTemplateEditor")}
        surface="chat"
      />
      <div className="flex flex-wrap items-center justify-end gap-1">
        {usingBuiltInDefault && (
          <button
            type="button"
            onClick={handleStartStandalonePrompt}
            disabled={saveAsPending}
            className="flex items-center gap-1 rounded-md bg-[var(--secondary)] px-2 py-1 text-[0.625rem] font-medium text-[var(--foreground)] ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)]"
          >
            <Copy size="0.625rem" />
            {localizeUi("ui.chatSettings.impersonatesection.copyBuiltInDefaultToEdit")}
          </button>
        )}
        {displayedPromptTemplate.trim() && (
          <button
            type="button"
            onClick={handleStartSaveAs}
            disabled={promptTemplateCatalogBusy}
            className="flex items-center gap-1 rounded-md bg-[var(--secondary)] px-2 py-1 text-[0.625rem] font-medium text-[var(--foreground)] ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Copy size="0.625rem" />
            {localizeUi("ui.chatSettings.impersonatesection.saveAs")}
          </button>
        )}
        {activePromptTemplate && (
          <button
            type="button"
            onClick={() => {
              void handleSavePromptTemplate();
            }}
            disabled={!hasPromptTemplate || !promptIsDirty || promptTemplateCatalogBusy}
            className="flex items-center gap-1 rounded-md bg-[var(--secondary)] px-2 py-1 text-[0.625rem] font-medium text-[var(--foreground)] ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Save size="0.625rem" />
            {localizeUi("ui.chatSettings.impersonatesection.save")}
          </button>
        )}
        {promptIsDirty && (
          <button
            type="button"
            onClick={handleResetPromptDraft}
            disabled={promptTemplateCatalogMutationPending}
            className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-40"
            title={localizeUi("ui.chatSettings.impersonatesection.resetUnsavedChanges")}
            aria-label={localizeUi("ui.chatSettings.impersonatesection.resetUnsavedChanges")}
          >
            <RotateCcw size="0.6875rem" />
          </button>
        )}
        {activePromptTemplate && (
          <button
            type="button"
            onClick={() => {
              void handleDeletePromptTemplate();
            }}
            disabled={promptTemplateCatalogBusy}
            className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--destructive)] transition-colors hover:bg-[var(--destructive)]/10 disabled:cursor-not-allowed disabled:opacity-40"
            title={localizeUi("ui.chatSettings.impersonatesection.deleteTemplate")}
            aria-label={localizeUi("ui.chatSettings.impersonatesection.deleteTemplate")}
          >
            <Trash2 size="0.6875rem" />
          </button>
        )}
      </div>
      {templateNameDraft !== null && (
        <div className="flex flex-wrap items-center gap-1.5 rounded-lg bg-[var(--secondary)]/40 p-1.5 ring-1 ring-[var(--border)]">
          <input
            autoFocus
            value={templateNameDraft}
            disabled={saveAsPending}
            onChange={(event) => setTemplateNameDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void handleSaveAsPromptTemplate();
              if (event.key === "Escape" && !saveAsPending) setTemplateNameDraft(null);
            }}
            maxLength={IMPERSONATE_PROMPT_TEMPLATE_MAX_NAME_LENGTH}
            placeholder={localizeUi("ui.chatSettings.impersonatesection.templateName")}
            className="min-w-40 flex-1 rounded-md bg-[var(--card)] px-2 py-1 text-xs text-[var(--foreground)] outline-none ring-1 ring-[var(--border)] focus:ring-2 focus:ring-[var(--ring)]"
          />
          <button
            type="button"
            onClick={() => {
              if (!saveAsPending) setTemplateNameDraft(null);
            }}
            disabled={saveAsPending}
            className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
            aria-label={localizeUi("ui.chatSettings.impersonatesection.cancel")}
          >
            <X size="0.75rem" />
          </button>
          <button
            type="button"
            onClick={() => {
              void handleSaveAsPromptTemplate();
            }}
            disabled={!templateNameDraft.trim() || !displayedPromptTemplate.trim() || promptTemplateCatalogBusy}
            className="flex items-center gap-1 rounded-md bg-[var(--secondary)] px-2.5 py-1.5 text-[0.6875rem] font-semibold text-[var(--foreground)] ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Save size="0.6875rem" />
            {localizeUi("ui.chatSettings.impersonatesection.saveAs")}
          </button>
        </div>
      )}
      {promptTemplatesQuery.isError && (
        <div className="flex items-center justify-between gap-2 rounded-lg bg-[var(--destructive)]/10 px-2.5 py-2 text-[0.6875rem] text-[var(--destructive)]">
          <span>{localizeUi("ui.chatSettings.impersonatesection.loadFailed")}</span>
          <button
            type="button"
            onClick={() => void promptTemplatesQuery.refetch()}
            className="shrink-0 rounded-md bg-[var(--secondary)] px-2 py-1 font-semibold text-[var(--foreground)] ring-1 ring-[var(--border)]"
          >
            {localizeUi("ui.chatSettings.impersonatesection.retry")}
          </button>
        </div>
      )}
    </div>
  );
}
