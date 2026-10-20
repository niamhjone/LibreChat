import { useMemo, useEffect } from 'react';
import { useRecoilState } from 'recoil';
import { usePromptGroupsInfiniteQuery } from '~/data-provider';
import { pendo } from '~/lib/pendo';
import store from '~/store';

/** FORK: the last name query and category reported to Pendo. Module scope, so a refetch or a
 *  further page of the same scope is not reported again; clearing both filters resets it. */
let lastTrackedPromptScope: string | null = null;

export default function usePromptGroupsNav(hasAccess = true) {
  const [pageSize] = useRecoilState(store.promptsPageSize);
  const [category] = useRecoilState(store.promptsCategory);
  const [name, setName] = useRecoilState(store.promptsName);

  const groupsQuery = usePromptGroupsInfiniteQuery(
    {
      name,
      pageSize,
      category,
    },
    {
      enabled: hasAccess,
    },
  );

  const promptGroups = useMemo(() => {
    if (!hasAccess || !groupsQuery.data?.pages) {
      return [];
    }
    return groupsQuery.data.pages.flatMap((page) => page.promptGroups ?? []);
  }, [hasAccess, groupsQuery.data?.pages]);

  /** `useNavScrolling` stops fetching once this is null */
  const nextCursor = useMemo(() => {
    const pages = groupsQuery.data?.pages;
    if (!hasAccess || !pages?.length) {
      return null;
    }
    const lastPage = pages[pages.length - 1];
    return lastPage.has_more === true ? (lastPage.after ?? null) : null;
  }, [hasAccess, groupsQuery.data?.pages]);

  useEffect(() => {
    if (!hasAccess) {
      return;
    }
    if (!name && !category) {
      lastTrackedPromptScope = null;
      return;
    }
    const scope = JSON.stringify({ name, category });
    if (groupsQuery.isFetching || scope === lastTrackedPromptScope) {
      return;
    }
    lastTrackedPromptScope = scope;
    // FORK: Pendo track event, once the scope's first page has settled. Zero results is a gap.
    pendo.track('prompt_library_searched', {
      resultsCount: promptGroups.length,
      hasMoreResults: nextCursor != null,
      category: category || undefined,
      queryLength: name.length,
      isError: groupsQuery.isError,
      searchQuery: name || undefined,
    });
  }, [
    hasAccess,
    name,
    category,
    groupsQuery.isFetching,
    groupsQuery.isError,
    promptGroups.length,
    nextCursor,
  ]);

  return {
    promptGroups,
    groupsQuery,
    nextCursor,
    fetchNextPage: groupsQuery.fetchNextPage,
    isFetchingNextPage: hasAccess ? groupsQuery.isFetchingNextPage : false,
    isFetching: hasAccess ? groupsQuery.isFetching : false,
    name,
    setName,
  };
}
