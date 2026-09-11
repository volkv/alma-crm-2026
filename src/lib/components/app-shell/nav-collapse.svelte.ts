import { browser } from '$app/environment';

const STORAGE_KEY = 'lct-crm:nav-collapsed';

/**
 * Whether the sidebar is collapsed to icons. The choice is the user's and it
 * outlives the page, so it lives in `localStorage` rather than in the URL or on
 * the server: it changes nothing anyone else can see.
 *
 * The server always renders the expanded sidebar — it has no way of knowing —
 * and the browser applies the stored choice as it hydrates.
 */
export function createNavCollapse() {
	let collapsed = $state(browser && localStorage.getItem(STORAGE_KEY) === 'true');

	return {
		get collapsed() {
			return collapsed;
		},
		toggle() {
			collapsed = !collapsed;
			localStorage.setItem(STORAGE_KEY, String(collapsed));
		}
	};
}
