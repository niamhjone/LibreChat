import { QueryKeys } from 'librechat-data-provider';
import { useQueryClient } from '@tanstack/react-query';
import type { BatchFile, TFile } from 'librechat-data-provider';
import { useDeleteFilesMutation } from '~/data-provider';
import useFileDeletion from './useFileDeletion';
import { failedFileIdsFrom } from '~/utils';
import { pendo } from '~/lib/pendo';

/** FORK: Pendo `files_bulk_deleted` properties for a delete request: counts and storage sources,
 *  never a file's name. */
function describeDeletion(files: BatchFile[]) {
  return {
    requestedCount: files.length,
    embeddedCount: files.filter((file) => file.embedded === true).length,
    storageSources: [...new Set(files.map((file) => file.source))],
  };
}

/** FORK: a request whose storage deletes all failed removed nothing, though it answered 200. */
function toDeletionOutcome(requestedCount: number, failedCount: number) {
  if (failedCount === 0) {
    return 'success';
  }
  return failedCount < requestedCount ? 'partial' : 'failed';
}

export default function useDeleteFilesFromTable(callback?: () => void) {
  const queryClient = useQueryClient();
  const deletionMutation = useDeleteFilesMutation({
    onMutate: async (variables) => {
      const { files } = variables;
      if (!files.length) {
        return new Map<string, BatchFile>();
      }

      const filesToDeleteMap = files.reduce((map, file) => {
        map.set(file.file_id, file);
        return map;
      }, new Map<string, BatchFile>());

      return { filesToDeleteMap };
    },
    onSuccess: (data, variables, context) => {
      console.log('Files deleted');
      const { filesToDeleteMap } = context as { filesToDeleteMap: Map<string, BatchFile> };
      const failed = new Set(failedFileIdsFrom(data));
      // FORK: Pendo track event. The route answers 200 even when storage deletes fail.
      const failedCount = variables.files.filter((file) => failed.has(file.file_id)).length;
      pendo.track('files_bulk_deleted', {
        outcome: toDeletionOutcome(variables.files.length, failedCount),
        deletedCount: variables.files.length - failedCount,
        failedCount,
        ...describeDeletion(variables.files),
      });

      queryClient.setQueryData([QueryKeys.files], (oldFiles: TFile[] | undefined) => {
        const { files } = variables;
        /** A resolved request is not proof the records are gone: the route answers a failed
         * storage delete with HTTP 200 and names the id in `failedFileIds`. */
        return files.length
          ? oldFiles?.filter(
              (file) => !filesToDeleteMap.has(file.file_id) || failed.has(file.file_id),
            )
          : oldFiles;
      });
      callback?.();
    },
    onError: (error, variables) => {
      console.log('Error deleting files:', error);
      // FORK: Pendo track event. How many files the failed request removed is unknown.
      const deletion = describeDeletion(variables?.files ?? []);
      pendo.track('files_bulk_deleted', { outcome: 'error', ...deletion });
      callback?.();
    },
  });

  return useFileDeletion({ mutateAsync: deletionMutation.mutateAsync });
}
