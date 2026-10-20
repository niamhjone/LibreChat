import { useEffect, useRef, useState } from 'react';
import { createCodeWorkerSetupCommand, isCodeWorkerShell } from 'librechat-data-provider';
import {
  Button,
  Chip,
  Input,
  Label,
  OGDialog,
  OGDialogTemplate,
  OGDialogTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  useToastContext,
} from '@librechat/client';
import type {
  CodeEnvironmentPermissionDecision,
  TCodeEnvironmentSummary,
  CodeWorkerShell,
} from 'librechat-data-provider';
import type { CodeEnvironmentPairingResponse } from '~/data-provider/CodeEnvironments';
import {
  useCodeEnvironmentsQuery,
  useCodeEnvironmentStatusQuery,
  useDeleteCodeEnvironmentMutation,
  usePairCodeEnvironmentMutation,
  useUpdateCodeEnvironmentSettingsMutation,
} from '~/data-provider';
import { useLocalize } from '~/hooks';
import { pendo } from '~/lib/pendo';

const statusPresentation = {
  offline: { label: 'com_ui_code_environment_status_offline', tone: 'error' },
  starting: { label: 'com_ui_code_environment_status_starting', tone: 'warning' },
  ready: { label: 'com_ui_code_environment_status_ready', tone: 'success' },
} as const;

/** FORK: Pendo `code_environment_ready` state, at module scope so it outlives this settings
 *  page: when each environment was paired in this page load, and those already reported. */
const pairedAt = new Map<string, number>();
const reportedReady = new Set<string>();

function EnvironmentStatus({
  environmentId,
  environmentType,
}: {
  environmentId: string;
  environmentType: TCodeEnvironmentSummary['type'];
}) {
  const localize = useLocalize();
  const query = useCodeEnvironmentStatusQuery(environmentId);
  const previousStatusRef = useRef(query.data?.status);
  useEffect(() => {
    const data = query.data;
    const previous = previousStatusRef.current;
    previousStatusRef.current = data?.status;
    if (data?.status !== 'ready' || reportedReady.has(environmentId)) {
      return;
    }
    /** Ready is news only after a status seen here was not, or for a pairing made in this page
     *  load: an environment already ready when the page opened is not reported. */
    const pairedAtMs = pairedAt.get(environmentId);
    if (pairedAtMs == null && (previous == null || previous === 'ready')) {
      return;
    }
    reportedReady.add(environmentId);
    // FORK: Pendo track event, the first time a worker finishes pairing and connects.
    pendo.track('code_environment_ready', {
      environmentType,
      statefulWorkspace: data.statefulWorkspace === true,
      sandboxProfile: data.sandboxProfile,
      runtimeCount: data.runtimes?.length ?? 0,
      timeToReadyMs: pairedAtMs != null ? Date.now() - pairedAtMs : undefined,
      environmentId,
    });
  }, [environmentId, environmentType, query.data]);
  if (query.isLoading) {
    return <Chip tone="neutral">{localize('com_ui_code_environment_status_checking')}</Chip>;
  }
  if (query.isError || query.data == null) {
    return <Chip tone="warning">{localize('com_ui_code_environment_status_unavailable')}</Chip>;
  }
  const presentation = statusPresentation[query.data.status];
  return (
    <div className="flex min-w-0 flex-col items-end gap-1">
      <Chip tone={presentation.tone}>{localize(presentation.label)}</Chip>
      {query.data.sandboxProfile != null && (
        <span className="text-text-tertiary max-w-48 truncate text-xs">
          {[query.data.sandboxProfile, ...(query.data.runtimes ?? [])].join(' · ')}
        </span>
      )}
    </div>
  );
}

function WorkerCommand({ pairing }: { pairing: CodeEnvironmentPairingResponse['pairing'] }) {
  const { showToast } = useToastContext();
  const localize = useLocalize();
  const [shell, setShell] = useState<CodeWorkerShell>('posix');
  const command = createCodeWorkerSetupCommand(pairing, shell, {
    allowWorkspaceWrites: true,
    allowWorkspaceCommands: true,
  });
  return (
    <div className="border-border-medium bg-surface-secondary flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-text-primary text-sm font-medium">
          {localize('com_ui_code_environment_pairing_ready')}
        </p>
        <Select
          value={shell}
          onValueChange={(value) => {
            if (isCodeWorkerShell(value)) {
              setShell(value);
            }
          }}
        >
          <SelectTrigger
            className="w-auto min-w-36"
            aria-label={localize('com_ui_code_environment_shell')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="posix">{localize('com_ui_code_environment_shell_posix')}</SelectItem>
            <SelectItem value="powershell">
              {localize('com_ui_code_environment_shell_powershell')}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      <p className="text-text-secondary text-xs">
        {localize('com_ui_code_environment_pairing_description')}
      </p>
      <pre className="bg-surface-tertiary text-text-primary overflow-x-auto rounded-md p-3 text-xs break-all whitespace-pre-wrap">
        {command}
      </pre>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(command);
            showToast({ message: localize('com_ui_copied_to_clipboard'), status: 'success' });
          } catch {
            showToast({ message: localize('com_ui_copy_failed'), status: 'error' });
          }
        }}
      >
        {localize('com_ui_copy_to_clipboard')}
      </Button>
    </div>
  );
}

const permissionLabels = {
  allow: 'com_ui_code_environment_permission_allow',
  ask: 'com_ui_code_environment_permission_ask',
  deny: 'com_ui_code_environment_permission_deny',
} as const;

function effectivePermission(
  field: NonNullable<
    NonNullable<NonNullable<TCodeEnvironmentSummary['configSchema']>['permissions']>['fileWrite']
  >,
  configured: CodeEnvironmentPermissionDecision | undefined,
): CodeEnvironmentPermissionDecision {
  return configured != null && field.allowed.includes(configured) ? configured : field.default;
}

function EnvironmentPermissions({ environment }: { environment: TCodeEnvironmentSummary }) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const updateMutation = useUpdateCodeEnvironmentSettingsMutation();
  const fields = environment.configSchema?.permissions;
  if (fields == null || !environment.canEdit) return null;

  const updatePermission = (
    category: 'fileWrite' | 'commandExecution',
    value: CodeEnvironmentPermissionDecision,
  ) => {
    updateMutation.mutate(
      { id: environment.id, settings: { permissions: { [category]: value } } },
      {
        onSuccess: () =>
          showToast({
            message: localize('com_ui_code_environment_permissions_saved'),
            status: 'success',
          }),
        onError: () =>
          showToast({
            message: localize('com_ui_code_environment_permissions_error'),
            status: 'error',
          }),
      },
    );
  };

  const controls = [
    {
      category: 'fileWrite' as const,
      label: 'com_ui_code_environment_file_write' as const,
      field: fields.fileWrite,
    },
    {
      category: 'commandExecution' as const,
      label: 'com_ui_code_environment_command_execution' as const,
      field: fields.commandExecution,
    },
  ].filter((control) => control.field != null);

  return (
    <div className="border-border-light mt-3 grid gap-3 border-t pt-3 sm:grid-cols-2">
      {controls.map(({ category, label, field }) => {
        if (field == null) return null;
        const value = effectivePermission(field, environment.settings?.permissions?.[category]);
        return (
          <div key={category} className="flex flex-col gap-1.5">
            <Label htmlFor={`${environment.id}-${category}`}>{localize(label)}</Label>
            <Select
              value={value}
              disabled={updateMutation.isLoading}
              onValueChange={(decision) =>
                updatePermission(category, decision as CodeEnvironmentPermissionDecision)
              }
            >
              <SelectTrigger id={`${environment.id}-${category}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {field.allowed.map((decision) => (
                  <SelectItem key={decision} value={decision}>
                    {localize(permissionLabels[decision])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        );
      })}
    </div>
  );
}

export default function CodeEnvironments() {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const query = useCodeEnvironmentsQuery();
  const pairMutation = usePairCodeEnvironmentMutation();
  const deleteMutation = useDeleteCodeEnvironmentMutation();
  const [name, setName] = useState('');
  const [controlPlaneId, setControlPlaneId] = useState('');
  const [pairing, setPairing] = useState<CodeEnvironmentPairingResponse['pairing']>();
  const controlPlanes = query.data?.controlPlanes ?? [];
  const selectedControlPlane = controlPlaneId || controlPlanes[0]?.id || '';

  useEffect(() => {
    if (pairing == null) return;
    const remaining = Date.parse(pairing.expiresAt) - Date.now();
    const delay = Number.isFinite(remaining) ? Math.max(0, remaining) : 0;
    const timeout = window.setTimeout(() => setPairing(undefined), delay);
    return () => window.clearTimeout(timeout);
  }, [pairing]);

  const pair = () => {
    const trimmedName = name.trim();
    if (!trimmedName || !selectedControlPlane) return;
    pairMutation.mutate(
      { name: trimmedName, controlPlaneId: selectedControlPlane },
      {
        onSuccess: (result) => {
          // FORK: starts the clock of the Pendo `code_environment_ready` event.
          pairedAt.set(result.environment.id, Date.now());
          setName('');
          setPairing(result.pairing);
          showToast({
            message: localize('com_ui_code_environment_pairing_created'),
            status: 'success',
          });
        },
        onError: () =>
          showToast({
            message: localize('com_ui_code_environment_pairing_error'),
            status: 'error',
          }),
      },
    );
  };

  let pairingControls = (
    <p className="text-text-secondary text-sm">{localize('com_ui_code_environment_unavailable')}</p>
  );
  if (query.isLoading) {
    pairingControls = (
      <div className="text-text-secondary flex items-center gap-2 text-sm">
        <Spinner />
        {localize('com_ui_loading')}
      </div>
    );
  } else if (query.isError) {
    pairingControls = (
      <p className="text-text-destructive text-sm">
        {localize('com_ui_code_environment_load_error')}
      </p>
    );
  } else if (controlPlanes.length > 0) {
    pairingControls = (
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
        <Input
          id="code-environment-name"
          value={name}
          maxLength={100}
          placeholder={localize('com_ui_code_environment_name_placeholder')}
          onChange={(event) => setName(event.target.value)}
        />
        <Select value={selectedControlPlane} onValueChange={setControlPlaneId}>
          <SelectTrigger aria-label={localize('com_ui_code_environment_control_plane')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {controlPlanes.map((controlPlane) => (
              <SelectItem key={controlPlane.id} value={controlPlane.id}>
                {controlPlane.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="button" disabled={!name.trim() || pairMutation.isLoading} onClick={pair}>
          {pairMutation.isLoading ? <Spinner /> : localize('com_ui_code_environment_pair')}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-4">
      <div>
        <Label htmlFor="code-environment-name">{localize('com_ui_code_environments')}</Label>
        <p className="text-text-secondary mt-1 text-xs">
          {localize('com_ui_code_environments_description')}
        </p>
      </div>

      {pairingControls}

      {pairing != null && <WorkerCommand pairing={pairing} />}

      <div className="flex flex-col gap-2">
        {(query.data?.environments ?? []).map((environment) => (
          <div key={environment.id} className="border-border-medium rounded-lg border p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-text-primary truncate text-sm font-medium">{environment.name}</p>
                <p className="text-text-secondary truncate text-xs">{environment.id}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {/* FORK: the type is for the Pendo `code_environment_ready` event. */}
                <EnvironmentStatus
                  environmentId={environment.id}
                  environmentType={environment.type}
                />
                {environment.canDelete && (
                  <OGDialog>
                    <OGDialogTrigger asChild>
                      <Button type="button" variant="outline" size="sm">
                        {localize('com_ui_delete')}
                      </Button>
                    </OGDialogTrigger>
                    <OGDialogTemplate
                      showCloseButton={false}
                      title={localize('com_ui_code_environment_remove_title')}
                      main={
                        <p className="text-text-secondary text-sm">
                          {localize('com_ui_code_environment_remove_description')}
                        </p>
                      }
                      selection={{
                        selectHandler: () =>
                          deleteMutation.mutate(environment.id, {
                            onSuccess: () =>
                              showToast({
                                message: localize('com_ui_code_environment_removed'),
                                status: 'success',
                              }),
                            onError: () =>
                              showToast({
                                message: localize('com_ui_code_environment_remove_error'),
                                status: 'error',
                              }),
                          }),
                        selectClasses:
                          'bg-surface-destructive text-text-on-status transition-all duration-200 hover:bg-surface-destructive-hover',
                        selectText: localize('com_ui_delete'),
                      }}
                    />
                  </OGDialog>
                )}
              </div>
            </div>
            <EnvironmentPermissions environment={environment} />
          </div>
        ))}
      </div>
    </div>
  );
}
