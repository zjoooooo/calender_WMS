// Shows a stored photo or signature (R35): the blob is fetched with the bearer token and cached by
// react-query (files are immutable); each component gets its own object URL, revoked on unmount.
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchFileBlob } from '../api';

export function useFileUrl(path: string | null | undefined): { url: string | null; error: unknown } {
  const q = useQuery({
    queryKey: ['file', path],
    queryFn: ({ signal }) => fetchFileBlob(path as string, { signal }),
    enabled: !!path,
    staleTime: Infinity,
    gcTime: 5 * 60_000,
  });
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!q.data) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(q.data);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [q.data]);
  return { url, error: q.error };
}
