import { createSignal, type Accessor } from 'solid-js';

import type { DiffLineAnchor } from '../store/types';

export type ReviewInteractionMode = 'review' | 'ask';

export interface ReviewSelection {
  source: string;
  lineBeginning?: string;
  startLine: number;
  endLine: number;
  selectedText: string;
  anchor?: DiffLineAnchor;
  afterLine?: number;
}

export interface ReviewAnnotation {
  id: string;
  source: string;
  lineBeginning?: string;
  startLine: number;
  endLine: number;
  selectedText: string;
  comment: string;
  anchor?: DiffLineAnchor;
}

export interface ReviewQuestion {
  id: string;
  source: string;
  afterLine: number;
  question: string;
  startLine: number;
  endLine: number;
  selectedText: string;
  anchor?: DiffLineAnchor;
}

export interface ReviewSession {
  activeQuestions: Accessor<ReviewQuestion[]>;
  annotations: Accessor<ReviewAnnotation[]>;
  canSubmit: Accessor<boolean>;
  clearPendingSelection: () => void;
  dismissAnnotation: (id: string) => void;
  dismissQuestion: (id: string) => void;
  handleSelection: (selection: ReviewSelection) => void;
  pendingSelection: Accessor<ReviewSelection | null>;
  updateAnnotation: (id: string, comment: string) => void;
  replaceAnnotations: (
    update: (annotations: ReadonlyArray<ReviewAnnotation>) => ReviewAnnotation[],
  ) => void;
  replaceQuestions: (
    update: (questions: ReadonlyArray<ReviewQuestion>) => ReviewQuestion[],
  ) => void;
  reset: () => void;
  scrollTarget: Accessor<ReviewAnnotation | null>;
  setScrollTarget: (annotation: ReviewAnnotation | null) => void;
  setSidebarOpen: (open: boolean) => void;
  sidebarOpen: Accessor<boolean>;
  submitError: Accessor<string>;
  submitReview: () => Promise<void>;
  submitSelection: (text: string, mode: ReviewInteractionMode) => string | null;
}

interface CreateReviewSessionOptions {
  canSubmit?: () => boolean;
  onSubmitReview?: (annotations: ReadonlyArray<ReviewAnnotation>) => Promise<void>;
  onSubmitted?: () => void;
}

function createAnnotation(selection: ReviewSelection, comment: string): ReviewAnnotation {
  return {
    id: crypto.randomUUID(),
    source: selection.source,
    ...(selection.lineBeginning ? { lineBeginning: selection.lineBeginning } : {}),
    startLine: selection.startLine,
    endLine: selection.endLine,
    selectedText: selection.selectedText,
    comment,
    ...(selection.anchor ? { anchor: selection.anchor } : {}),
  };
}

function createQuestion(selection: ReviewSelection, question: string): ReviewQuestion {
  return {
    id: crypto.randomUUID(),
    source: selection.source,
    afterLine: selection.afterLine ?? selection.endLine,
    question,
    startLine: selection.startLine,
    endLine: selection.endLine,
    selectedText: selection.selectedText,
    ...(selection.anchor ? { anchor: selection.anchor } : {}),
  };
}

export function createReviewSession(options: CreateReviewSessionOptions = {}): ReviewSession {
  const [annotations, setAnnotations] = createSignal<ReviewAnnotation[]>([]);
  const [activeQuestions, setActiveQuestions] = createSignal<ReviewQuestion[]>([]);
  const [pendingSelection, setPendingSelection] = createSignal<ReviewSelection | null>(null);
  const [scrollTarget, setScrollTarget] = createSignal<ReviewAnnotation | null>(null, {
    equals: false,
  });
  const [sidebarOpen, setSidebarOpen] = createSignal(false);
  const [submitError, setSubmitError] = createSignal('');

  function handleSelection(selection: ReviewSelection): void {
    setPendingSelection(selection);
  }

  function clearPendingSelection(): void {
    setPendingSelection(null);
  }

  function dismissAnnotation(id: string): void {
    setAnnotations((current) => current.filter((annotation) => annotation.id !== id));
  }

  function updateAnnotation(id: string, comment: string): void {
    const trimmedComment = comment.trim();
    if (!trimmedComment) {
      return;
    }

    setAnnotations((current) => {
      const annotationIndex = current.findIndex((annotation) => annotation.id === id);
      if (annotationIndex === -1 || current[annotationIndex]?.comment === trimmedComment) {
        return current;
      }

      const nextAnnotations = [...current];
      const currentAnnotation = nextAnnotations[annotationIndex];
      if (!currentAnnotation) {
        return current;
      }

      nextAnnotations[annotationIndex] = {
        ...currentAnnotation,
        comment: trimmedComment,
      };
      return nextAnnotations;
    });
  }

  function dismissQuestion(id: string): void {
    setActiveQuestions((current) => current.filter((question) => question.id !== id));
  }

  function replaceAnnotations(
    update: (annotations: ReadonlyArray<ReviewAnnotation>) => ReviewAnnotation[],
  ): void {
    setAnnotations((current) => update(current));
  }

  function replaceQuestions(
    update: (questions: ReadonlyArray<ReviewQuestion>) => ReviewQuestion[],
  ): void {
    setActiveQuestions((current) => update(current));
  }

  function reset(): void {
    setAnnotations([]);
    setActiveQuestions([]);
    setPendingSelection(null);
    setScrollTarget(null);
    setSidebarOpen(false);
    setSubmitError('');
  }

  function submitSelection(text: string, mode: ReviewInteractionMode): string | null {
    const selection = pendingSelection();
    const trimmedText = text.trim();
    if (!selection || !trimmedText) {
      return null;
    }

    if (mode === 'review') {
      const annotation = createAnnotation(selection, trimmedText);
      setAnnotations((current) => [...current, annotation]);
      setSidebarOpen(true);
      clearPendingSelection();
      return annotation.id;
    }

    const question = createQuestion(selection, trimmedText);
    setActiveQuestions((current) => [...current, question]);
    clearPendingSelection();
    return question.id;
  }

  async function submitReview(): Promise<void> {
    if (!options.onSubmitReview || annotations().length === 0) {
      return;
    }

    if (!canSubmit()) {
      setSubmitError('No agent available to receive review');
      return;
    }

    setSubmitError('');
    await options
      .onSubmitReview(annotations())
      .then(() => {
        setAnnotations([]);
        setSidebarOpen(false);
        options.onSubmitted?.();
      })
      .catch((error: unknown) => {
        setSubmitError(error instanceof Error ? error.message : 'Failed to send review');
      });
  }

  function canSubmit(): boolean {
    return options.canSubmit ? options.canSubmit() : true;
  }

  return {
    activeQuestions,
    annotations,
    canSubmit,
    clearPendingSelection,
    dismissAnnotation,
    dismissQuestion,
    handleSelection,
    pendingSelection,
    updateAnnotation,
    replaceAnnotations,
    replaceQuestions,
    reset,
    scrollTarget,
    setScrollTarget,
    setSidebarOpen,
    sidebarOpen,
    submitError,
    submitReview,
    submitSelection,
  };
}
