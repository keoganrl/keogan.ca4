import { writable } from 'svelte/store';
import { supabase } from '../supabase';

// Components render with client:only, but guard anyway so nothing touches
// localStorage during a build.
const browser = typeof window !== 'undefined';

function getOrCreateIdentityId(): string {
  if (!browser) return '';
  let id = localStorage.getItem('poker_identity_id');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('poker_identity_id', id);
  }
  return id;
}

export const identityId = writable<string>('');
export const displayName = writable<string>('');

export async function initIdentity() {
  const id = getOrCreateIdentityId();
  identityId.set(id);

  const { data } = await supabase
    .from('players_identity')
    .select('display_name')
    .eq('id', id)
    .single();

  if (data?.display_name) {
    displayName.set(data.display_name);
  }
}

export async function saveIdentity(name: string) {
  const id = getOrCreateIdentityId();
  displayName.set(name);

  await supabase.from('players_identity').upsert({
    id,
    display_name: name
  });
}
