interface HydraArtifactToggleLabelOptions {
  count: number;
  expanded: boolean;
}

export function getHiddenHydraSummaryLabel(count: number): string {
  return `Hydra hidden: ${count}`;
}

export function getHiddenHydraSummaryTitle(count: number): string {
  return `${count} Hydra coordination files hidden`;
}

export function getHydraArtifactToggleLabel(options: HydraArtifactToggleLabelOptions): string {
  if (options.expanded) {
    return 'Hide Hydra files';
  }

  return `Show Hydra files (${options.count})`;
}

export function getHydraArtifactToggleTitle(options: HydraArtifactToggleLabelOptions): string {
  if (options.expanded) {
    return 'Hide Hydra coordination files';
  }

  return `Show ${options.count} Hydra coordination files`;
}
