/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { IQuickDiffService, QuickDiff, QuickDiffProvider } from './quickDiff.js';
import { isEqualOrParent } from '../../../../base/common/resources.js';
import { score } from '../../../../editor/common/languageSelector.js';
import { Emitter } from '../../../../base/common/event.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

function createProviderComparer(uri: URI): (a: QuickDiffProvider, b: QuickDiffProvider) => number {
	return (a, b) => {
		if (a.rootUri && !b.rootUri) {
			return -1;
		} else if (!a.rootUri && b.rootUri) {
			return 1;
		} else if (!a.rootUri && !b.rootUri) {
			return 0;
		}

		const aIsParent = isEqualOrParent(uri, a.rootUri!);
		const bIsParent = isEqualOrParent(uri, b.rootUri!);

		if (aIsParent && bIsParent) {
			return providerComparer(a, b);
		} else if (aIsParent) {
			return -1;
		} else if (bIsParent) {
			return 1;
		} else {
			return 0;
		}
	};
}

function providerComparer(a: QuickDiffProvider, b: QuickDiffProvider): number {
	if (a.kind === 'primary') {
		return -1;
	} else if (b.kind === 'primary') {
		return 1;
	} else if (a.kind === 'secondary') {
		return -1;
	} else if (b.kind === 'secondary') {
		return 1;
	}
	return 0;
}

export class QuickDiffService extends Disposable implements IQuickDiffService {
	declare readonly _serviceBrand: undefined;
	private static readonly STORAGE_KEY = 'workbench.scm.quickDiffProviders.hidden';

	private quickDiffProviders: Map<string, QuickDiffProvider> = new Map();
	get providers(): readonly QuickDiffProvider[] {
		return Array.from(this.quickDiffProviders.values()).sort(providerComparer);
	}

	private readonly _onDidChangeQuickDiffProviders = this._register(new Emitter<void>());
	readonly onDidChangeQuickDiffProviders = this._onDidChangeQuickDiffProviders.event;

	private hiddenQuickDiffProviders = new Set<string>();

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService
	) {
		super();

		this.loadState();
	}

	addQuickDiffProvider(quickDiff: QuickDiffProvider): IDisposable {
		this.quickDiffProviders.set(quickDiff.id, quickDiff);
		this._onDidChangeQuickDiffProviders.fire();
		return {
			dispose: () => {
				this.quickDiffProviders.delete(quickDiff.id);
				this._onDidChangeQuickDiffProviders.fire();
			}
		};
	}

	async getQuickDiffs(uri: URI, language: string = '', isSynchronized: boolean = false): Promise<QuickDiff[]> {
		const providers = Array.from(this.quickDiffProviders.values())
			.filter(provider => !provider.rootUri || this.uriIdentityService.extUri.isEqualOrParent(uri, provider.rootUri))
			.sort(createProviderComparer(uri));

		const quickDiffs = await Promise.all(providers.map(async provider => {
			const visible = this.isQuickDiffProviderVisible(provider.id);
			const scoreValue = provider.selector ? score(provider.selector, uri, language, isSynchronized, undefined, undefined) : 10;
			const originalResource = scoreValue > 0 ? await provider.getOriginalResource(uri) ?? undefined : undefined;

			return {
				id: provider.id,
				label: provider.label,
				visible: visible,
				kind: provider.kind,
				originalResource
			} satisfies Partial<QuickDiff>;
		}));

		return quickDiffs.filter(this.isQuickDiff);
	}

	toggleQuickDiffProviderVisibility(id: string): void {
		if (!this.quickDiffProviders.has(id)) {
			return;
		}

		if (this.isQuickDiffProviderVisible(id)) {
			this.hiddenQuickDiffProviders.add(id);
		} else {
			this.hiddenQuickDiffProviders.delete(id);
		}

		this.saveState();
		this._onDidChangeQuickDiffProviders.fire();
	}

	isQuickDiffProviderVisible(id: string): boolean {
		return !this.hiddenQuickDiffProviders.has(id);
	}

	private loadState(): void {
		const raw = this.storageService.get(QuickDiffService.STORAGE_KEY, StorageScope.PROFILE);
		if (raw) {
			try {
				this.hiddenQuickDiffProviders = new Set(JSON.parse(raw));
			} catch { }
		}
	}

	private saveState(): void {
		if (this.hiddenQuickDiffProviders.size === 0) {
			this.storageService.remove(QuickDiffService.STORAGE_KEY, StorageScope.PROFILE);
		} else {
			this.storageService.store(QuickDiffService.STORAGE_KEY, JSON.stringify(Array.from(this.hiddenQuickDiffProviders)), StorageScope.PROFILE, StorageTarget.USER);
		}
	}

	private isQuickDiff(diff: { id?: string; label?: string; originalResource?: URI }): diff is QuickDiff {
		return typeof diff.id === 'string' && typeof diff.label === 'string' && !!diff.originalResource;
	}
}

export async function getOriginalResource(quickDiffService: IQuickDiffService, uri: URI, language: string | undefined, isSynchronized: boolean | undefined): Promise<URI | null> {
	const quickDiffs = await quickDiffService.getQuickDiffs(uri, language, isSynchronized);
	return quickDiffs.length > 0 ? quickDiffs[0].originalResource : null;
}
