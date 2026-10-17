import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  FolderOpen,
  Puzzle,
  RefreshCw,
  Search,
  Sparkles,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { api, type SkillCatalogView, type SkillView } from "@/api/client";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Field,
  Input,
  SectionLabel,
  Select,
  Skeleton,
  isComposingEvent,
} from "@/cds";
import { InlineError, PanelHeader, PanelScroll } from "@/features/panels/Chrome";
import { cx } from "@/lib/cx";
import { errorMessage } from "@/lib/errorMessage";
import { truncate } from "@/lib/format";
import {
  applySkillToggle,
  filterSkills,
  skillCounts,
  type SkillFilter,
} from "./logic";

export function SkillsPanel({
  workDir,
  initialSkills = [],
}: {
  workDir: string;
  initialSkills?: SkillView[];
}) {
  const queryClient = useQueryClient();
  const queryKey = ["skills", workDir] as const;
  const catalogQuery = useQuery({
    queryKey,
    queryFn: () => api.skillCatalog(workDir),
    initialData: { skills: initialSkills, dirs: [] } satisfies SkillCatalogView,
  });
  const catalog = catalogQuery.data;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SkillFilter>("all");
  const [actionError, setActionError] = useState<string | null>(null);
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [discoverQuery, setDiscoverQuery] = useState("");
  const composing = useRef(false);

  useEffect(() => {
    if (!actionError) return;
    const timer = setTimeout(() => setActionError(null), 6000);
    return () => clearTimeout(timer);
  }, [actionError]);

  const toggle = useMutation({
    mutationFn: (input: { name: string; enabled: boolean; path?: string | null }) =>
      input.enabled
        ? api.enableSkill(input.name, input.path)
        : api.disableSkill(input.name),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<SkillCatalogView>(queryKey);
      queryClient.setQueryData<SkillCatalogView>(queryKey, (current) =>
        current
          ? {
              ...current,
              skills: applySkillToggle(current.skills, input.name, input.enabled),
            }
          : current,
      );
      return { previous };
    },
    onSuccess: (result) => {
      queryClient.setQueryData<SkillCatalogView>(queryKey, (current) =>
        current ? { ...current, skills: result.skills } : current,
      );
    },
    onError: (error, _input, context) => {
      if (context?.previous) queryClient.setQueryData(queryKey, context.previous);
      setActionError(errorMessage(error, "The skill could not be updated."));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const discover = useMutation({
    mutationFn: () =>
      api.discoverSkills({
        cwd: workDir,
        query: discoverQuery.trim() || undefined,
      }),
    onError: (error) =>
      setActionError(errorMessage(error, "Skill discovery failed.")),
  });

  const submitDiscover = (event: FormEvent) => {
    event.preventDefault();
    discover.mutate();
  };

  const onDiscoverKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && (isComposingEvent(event) || composing.current)) {
      event.preventDefault();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      discover.mutate();
    }
  };

  const counts = skillCounts(catalog.skills);
  const visible = filterSkills(catalog.skills, query, filter);
  const pendingName = toggle.isPending ? toggle.variables?.name ?? null : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        icon={<Puzzle size={14} strokeWidth={2} />}
        title="Skills"
        meta={`${counts.enabled}/${counts.total}`}
        actions={
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh skills"
              onClick={() => void catalogQuery.refetch()}
              loading={catalogQuery.isFetching}
            >
              <RefreshCw size={13} strokeWidth={2} />
            </Button>
            <Button
              variant={discoverOpen ? "soft" : "ghost"}
              size="icon-sm"
              aria-label="Discover skills"
              aria-pressed={discoverOpen}
              onClick={() => setDiscoverOpen((value) => !value)}
            >
              <Sparkles size={13} strokeWidth={2} />
            </Button>
          </>
        }
      />
      <PanelScroll>
        <div className="flex flex-col gap-3">
          {actionError ? (
            <InlineError message={actionError} onDismiss={() => setActionError(null)} />
          ) : null}

          {discoverOpen ? (
            <div className="flex flex-col gap-2.5 rounded-card bg-surface p-3 animate-fade-up">
              <form className="flex items-center gap-2" onSubmit={submitDiscover}>
                <Input
                  aria-label="Skill discovery query"
                  placeholder="Search project skills"
                  value={discoverQuery}
                  onChange={(event) => setDiscoverQuery(event.target.value)}
                  onKeyDown={onDiscoverKeyDown}
                  onCompositionStart={() => {
                    composing.current = true;
                  }}
                  onCompositionEnd={() => {
                    composing.current = false;
                  }}
                />
                <Button
                  type="submit"
                  size="sm"
                  variant="secondary"
                  loading={discover.isPending}
                >
                  Scan
                </Button>
              </form>
              {discover.isPending ? (
                <div className="flex flex-col gap-2">
                  <Skeleton className="h-10" />
                  <Skeleton className="h-10" />
                </div>
              ) : discover.data ? (
                discover.data.items.length === 0 ? (
                  <p className="px-1 py-2 text-[12px] text-ink-3">
                    No matching skill files in {truncate(workDir, 42)}.
                  </p>
                ) : (
                  <ul className="flex flex-col gap-0.5">
                    {discover.data.items.map((item) => {
                      const existing = catalog.skills.find(
                        (skill) => skill.name === item.name,
                      );
                      return (
                        <li
                          key={item.id}
                          className="flex items-center gap-2 rounded-lg px-1.5 py-1.5"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[12.5px] font-medium text-ink">
                              {item.name}
                            </p>
                            <p
                              className="truncate text-[11px] text-ink-3"
                              title={item.path}
                            >
                              {item.path}
                            </p>
                          </div>
                          {existing?.enabled ? (
                            <Badge tone="ok">
                              <Check size={11} strokeWidth={2.4} />
                              Enabled
                            </Badge>
                          ) : (
                            <Button
                              size="xs"
                              variant="soft"
                              disabled={pendingName === item.name}
                              onClick={() =>
                                toggle.mutate({
                                  name: item.name,
                                  enabled: true,
                                  path: item.path,
                                })
                              }
                            >
                              Enable
                            </Button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )
              ) : (
                <p className="px-1 py-1 text-[11.5px] text-ink-3">
                  Scans the project for SKILL.md files and skill directories.
                </p>
              )}
            </div>
          ) : null}

          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search
                size={13}
                strokeWidth={2}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3"
                aria-hidden
              />
              <Input
                aria-label="Filter skills"
                placeholder="Filter skills"
                className="pl-8"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <Select
              aria-label="Skill source"
              className="w-[104px] flex-none"
              value={filter}
              onChange={(event) => setFilter(event.target.value as SkillFilter)}
            >
              <option value="all">All</option>
              <option value="enabled">Enabled</option>
              <option value="system">System</option>
              <option value="project">Project</option>
            </Select>
          </div>

          {catalogQuery.isError ? (
            <ErrorState
              title="Skills unavailable"
              message={errorMessage(catalogQuery.error, "The skill catalog could not be read.")}
              retry={() => void catalogQuery.refetch()}
              retrying={catalogQuery.isFetching}
            />
          ) : catalogQuery.isLoading ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
            </div>
          ) : visible.length === 0 ? (
            <EmptyState
              icon={<Puzzle size={18} strokeWidth={1.8} />}
              title={query ? "No matching skills" : "No skills found"}
              description={
                query
                  ? "Try a different name or source filter."
                  : "Add a SKILL.md under .claude/skills or .autoagent/skills, then refresh."
              }
            />
          ) : (
            <ul className="flex flex-col">
              {visible.map((skill) => {
                const enabled = skill.enabled;
                return (
                  <li
                    key={skill.name}
                    className="flex items-start gap-3 rounded-lg px-1.5 py-2 transition-colors duration-150 ease-out-expo hover:bg-hover"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <p className="truncate text-[12.5px] font-medium text-ink">
                          {skill.name}
                        </p>
                        <Badge tone={skill.source === "project" ? "info" : "neutral"}>
                          {skill.source}
                        </Badge>
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-relaxed text-ink-2">
                        {skill.description}
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={enabled}
                      aria-label={`${enabled ? "Disable" : "Enable"} ${skill.name}`}
                      disabled={pendingName === skill.name}
                      onClick={() =>
                        toggle.mutate({
                          name: skill.name,
                          enabled: !enabled,
                          path: skill.path,
                        })
                      }
                      className={cx(
                        "relative mt-1 h-5 w-9 flex-none rounded-full transition-[background-color,opacity] duration-150 ease-out-expo focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-50",
                        enabled ? "bg-accent" : "bg-line-strong",
                      )}
                    >
                      <span
                        className={cx(
                          "absolute top-0.5 h-4 w-4 rounded-full bg-panel shadow-thumb transition-[left] duration-200 ease-out-expo",
                          enabled ? "left-[18px]" : "left-0.5",
                        )}
                      />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="mt-1 flex flex-col gap-1.5">
            <SectionLabel>Source directories</SectionLabel>
            <ul className="flex flex-col gap-0.5">
              {catalog.dirs.map((dir) => (
                <li
                  key={`${dir.source}:${dir.path}`}
                  className="flex items-center gap-2 rounded-lg px-1.5 py-1.5"
                >
                  <FolderOpen
                    size={13}
                    strokeWidth={1.9}
                    className={dir.exists ? "text-ink-3" : "text-ink-3/50"}
                    aria-hidden
                  />
                  <span
                    className={cx(
                      "min-w-0 flex-1 truncate font-mono text-[11px]",
                      dir.exists ? "text-ink-2" : "text-ink-3",
                    )}
                    title={dir.path}
                  >
                    {dir.path}
                  </span>
                  <Badge tone={dir.source === "project" ? "info" : "neutral"}>
                    {dir.source}
                  </Badge>
                  {!dir.exists ? <Badge tone="warn">missing</Badge> : null}
                </li>
              ))}
            </ul>
          </div>

          <Field label="Workspace" htmlFor="skills-workdir" hint="Catalog scans resolve against this directory.">
            <Input id="skills-workdir" readOnly value={workDir} className="font-mono text-[11.5px]" />
          </Field>
        </div>
      </PanelScroll>
    </div>
  );
}
