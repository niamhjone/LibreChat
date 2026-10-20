import { QueryKeys } from 'librechat-data-provider';
import { useQueryClient } from '@tanstack/react-query';
import type { BatchFile, TFile } from 'librechat-data-provider';
import { useDeleteFilesMutation } from '~/data-provider';
import useFileDeletion from './useFileDeletion';
import { failedFileIdsFrom } from '~/utils';
import { pendo } from '~/lib/pendo';

/** FORK: what the Pendo `files_deleted` event says about a batch. Counts and storage sources
 *  only, never a file's name or path. */
const describeBatch = (files: BatchFile[]) => ({
  storageSources: [...new Set(files.map((file) => file.source))],
  embeddedCount: files.filter((file) => file.embedded).length,
});

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
      // FORK: Pendo track event. A failed storage delete still answers 200, in `failedFileIds`.
      const failedCount = variables.files.filter((file) => failed.has(file.file_id)).length;
      pendo.track('files_deleted', {
        outcome: failedCount === 0 ? 'success' : 'partial',
        requestedCount: variables.files.length,
        deletedCount: variables.files.length - failedCount,
        failedCount,
        ...describeBatch(variables.files),
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
      // FORK: Pendo track event. The request failed, so how many files went is unknown.
      pendo.track('files_deleted', {
        outcome: 'error',
        requestedCount: variables.files.length,
        ...describeBatch(variables.files),
      });
      callback?.();
    },
  });

  return useFileDeletion({ mutateAsync: deletionMutation.mutateAsync });
}
