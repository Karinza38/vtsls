import { fuzzyScore, FuzzyScore, fuzzyScoreGracefulAggressive } from "@vtsls/vscode-fuzzy";
import { CommandsShimService } from "shims/commands";
import { ConfigurationShimService } from "shims/configuration";
import { CompletionRegistryHandle } from "shims/languageFeatures";
import * as types from "shims/types";
import { RestrictedCache } from "utils/cache";
import { TSLspConverter } from "utils/converter";
import { Disposable } from "utils/dispose";
import { isNil } from "utils/types";
import * as vscode from "vscode";
import * as lsp from "vscode-languageserver-protocol";

interface CompletionItemData {
  providerId: number;
  index: number;
  cacheId: number;
  match?: FuzzyScore;
}

export class CompletionCache extends Disposable {
  static readonly id = "_vtsls.completionCacheCommand";

  constructor(commands: CommandsShimService) {
    super();

    this._register(
      commands.registerCommand(CompletionCache.id, (...args) => {
        const item = this.resolveData(args[0])?.cachedItem;
        if (!item) {
          throw new lsp.ResponseError(lsp.ErrorCodes.InvalidParams, "completion item data missing");
        }
        if (item.command && item.command.command !== CompletionCache.id) {
          return commands.executeCommand(item.command.command, ...item.command.arguments);
        }
      })
    );
  }

  private readonly completionItemCache = this._register(
    new RestrictedCache<vscode.CompletionItem[]>(5)
  );

  store(items: vscode.CompletionItem[], providerId: number) {
    const cacheId = this.completionItemCache.store(items);
    return items.map((_, index) => {
      const data = this.createData(providerId, index, cacheId);
      return { data, command: { command: CompletionCache.id, title: "", arguments: [data] } };
    });
  }

  resolveData(
    data?: any
  ): ({ cachedItem: vscode.CompletionItem } & CompletionItemData) | undefined {
    const { providerId: _providerId, index: _index, cacheId: _cacheId } = data || {};
    if ([_providerId, _index, _cacheId].some(isNil)) {
      return;
    }
    const providerId = _providerId as number;
    const index = _index as number;
    const cacheId = _cacheId as number;
    const cachedItem = this.completionItemCache.get(cacheId)?.[index];
    if (!cachedItem) {
      return;
    }
    return { cachedItem, providerId, index, cacheId };
  }

  private createData(providerId: number, index: number, cacheId: number): CompletionItemData {
    return {
      providerId,
      index,
      cacheId,
    };
  }
}

export class TSCompletionFeature extends Disposable {
  private cache: CompletionCache;

  constructor(
    private registry: CompletionRegistryHandle,
    private configuration: ConfigurationShimService,
    commands: CommandsShimService,
    private converter: TSLspConverter
  ) {
    super();
    this.cache = this._register(new CompletionCache(commands));
  }

  async completion(
    doc: vscode.TextDocument,
    params: Omit<lsp.CompletionParams, "textDocument">,
    token: lsp.CancellationToken
  ) {
    const providers = this.registry.getProviders(doc);

    const experimentalCompletionConfig = this.configuration.getConfiguration(
      "vtsls.experimental.completion"
    );
    const enableServerSideFuzzyMatch = experimentalCompletionConfig.get<boolean>(
      "enableServerSideFuzzyMatch"
    );
    const entriesLimit = experimentalCompletionConfig.get<number | null>("entriesLimit");

    const ctx = params.context
      ? {
          triggerKind: params.context.triggerKind - 1,
          triggerCharacter: params.context.triggerCharacter,
        }
      : {
          triggerKind: types.CompletionTriggerKind.Invoke,
          triggerCharacter: "",
        };
    const pos = types.Position.of(params.position);
    const wordRange = doc.getWordRangeAtPosition(pos);
    const leadingLineContent = doc.getText(new types.Range(pos.line, 0, pos.line, pos.character));
    const inWord = wordRange?.contains(new types.Position(pos.line, pos.character - 1));

    const results: {
      items: vscode.CompletionItem[];
      matches?: FuzzyScore[];
      providerId: number;
    }[] = [];
    let isIncomplete = false;

    for (const {
      id: providerId,
      provider,
      args: { triggerCharacters },
    } of providers) {
      const checkTriggerCharacter =
        ctx.triggerCharacter && triggerCharacters.includes(ctx.triggerCharacter);
      if (
        ctx.triggerKind === types.CompletionTriggerKind.TriggerCharacter &&
        !checkTriggerCharacter &&
        !inWord // by default, identifier chars should be also considered as trigger char
      ) {
        continue;
      }

      const items = await provider.provideCompletionItems(doc, pos, token, ctx);
      if (!items) {
        continue;
      }

      let itemsArr: vscode.CompletionItem[];
      if (Array.isArray(items)) {
        itemsArr = items;
      } else {
        isIncomplete = isIncomplete || Boolean(items.isIncomplete);
        itemsArr = items.items;
      }

      if (itemsArr.length === 0) {
        continue;
      }

      if (enableServerSideFuzzyMatch && wordRange) {
        const { filteredItems, matches } = this.filterByFuzzyMatches(
          itemsArr,
          pos,
          wordRange,
          leadingLineContent
        );

        if (filteredItems.length > 0) {
          results.push({ items: filteredItems, matches, providerId });
        }
      } else {
        results.push({ items: itemsArr, providerId });
      }
    }

    let resultItems: lsp.CompletionItem[] = [];
    for (const { items, matches, providerId } of results) {
      const overrideFields = this.cache.store(items, providerId);
      for (let i = 0; i < items.length; ++i) {
        const { data, command } = overrideFields[i];
        const converted = this.converter.convertCompletionItem(items[i], {
          ...data,
          // attach match result in data for trimming
          match: matches?.[i],
        });
        resultItems.push({
          ...converted,
          command,
        });
      }
    }

    if (!isNil(entriesLimit) && resultItems.length > entriesLimit) {
      // mark as inComplete as some entries are trimmed
      isIncomplete = true;
      resultItems = this.trimCompletionItems(resultItems, entriesLimit);
    }
    return lsp.CompletionList.create(resultItems, isIncomplete);
  }

  async completionItemResolve(item: lsp.CompletionItem, token: lsp.CancellationToken) {
    const cached = this.cache.resolveData(item.data);
    if (!cached) {
      return item;
    }
    const { cachedItem, providerId } = cached;
    const entry = this.registry.getProviderById(providerId);
    if (!entry || !entry.provider.resolveCompletionItem) {
      return item;
    }
    const result = await entry.provider.resolveCompletionItem(cachedItem, token);
    if (result) {
      // restore origin transformed data and command
      const converted = this.converter.convertCompletionItem(result, item.data);
      converted.command = item.command;
      return converted;
    } else {
      return item;
    }
  }

  private filterByFuzzyMatches(
    items: vscode.CompletionItem[],
    position: vscode.Position,
    wordRange: vscode.Range,
    leadingLineContent: string
  ) {
    const scoreFn = items.length > 2000 ? fuzzyScore : fuzzyScoreGracefulAggressive;

    let word = "";
    let wordLow = "";
    const getFuzzyScore = (item: vscode.CompletionItem) => {
      const editStartColumn = item.range
        ? types.Range.isRange(item.range)
          ? item.range.start.character
          : item.range?.inserting.start.character
        : wordRange?.start.character ?? position.character;

      const wordLen = position.character - editStartColumn;
      if (word.length !== wordLen) {
        word = wordLen === 0 ? "" : leadingLineContent.slice(-wordLen);
        wordLow = word.toLowerCase();
      }

      if (wordLen === 0) {
        return FuzzyScore.Default;
      } else {
        // skip word characters that are whitespace until
        // we have hit the replace range (overwriteBefore)
        let wordPos = 0;
        while (wordPos < wordLen) {
          const ch = word.charCodeAt(wordPos);
          if (isWhitespace(ch)) {
            wordPos += 1;
          } else {
            break;
          }
        }
        if (wordPos >= wordLen) {
          return FuzzyScore.Default;
        }

        if (typeof item.filterText === "string") {
          const match = scoreFn(
            word,
            wordLow,
            wordPos,
            item.filterText,
            item.filterText.toLowerCase(),
            0
          );
          return match;
        } else {
          const textLabel = typeof item.label === "string" ? item.label : item.label?.label;
          const match = scoreFn(word, wordLow, wordPos, textLabel, textLabel.toLowerCase(), 0);
          return match;
        }
      }
    };

    const filteredItems: vscode.CompletionItem[] = [];
    const matches: FuzzyScore[] = [];

    for (const item of items) {
      const match = getFuzzyScore(item);
      if (match) {
        filteredItems.push(item);
        matches.push(match);
      }
    }

    return { filteredItems, matches };
  }

  private trimCompletionItems(items: lsp.CompletionItem[], limit: number) {
    const wrappedItems = items.map((item, idx) => ({
      item,
      idx,
      sortText: item.sortText ?? item.label,
      // use fuzzy matched score if possible
      match: (item.data as CompletionItemData)?.match,
    }));
    wrappedItems.sort((a, b) => {
      if (a.match && b.match) {
        // score
        if (a.match[0] < b.match[0]) {
          return 1;
        } else if (a.match[0] > b.match[0]) {
          return -1;
        } else if (a.match[1] < b.match[1]) {
          // first match
          return -1;
        } else if (a.match[1] > b.match[1]) {
          return 1;
        }
      }
      if (a.sortText < b.sortText) {
        return -1;
      } else if (a.sortText > b.sortText) {
        return 1;
      } else {
        return a.idx - b.idx;
      }
    });
    return wrappedItems.slice(0, limit).map((v) => v.item);
  }
}

function isWhitespace(code: number): boolean {
  // space or tab
  return code === 32 || code === 9;
}
