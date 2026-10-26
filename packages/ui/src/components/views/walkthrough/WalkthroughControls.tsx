import { Fragment, useState } from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { Spinner } from '@/components/ui/spinner';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { type Locale, useI18n } from '@/lib/i18n';
import type { WalkthroughView } from '@/lib/walkthrough/model';
import { cn } from '@/lib/utils';
import type { WalkthroughReview } from './useWalkthroughReview';
import { MENU_GROUP_LABEL_CLASS, WALKTHROUGH_ACTION_CLASS, openWalkthroughGuide } from './walkthroughAction';

// Pickers inside the phone's options sheet open above it: the sheet sits at
// z-60 and a menu's default layer would open underneath.
const OVER_SHEET_POSITIONER_CLASS = 'z-[70]';

type ControlSize = 'default' | 'mobile';

/**
 * A walkthrough nobody can read is worth nothing, so the prose language is a
 * per-review choice like the model — defaulting to the interface language,
 * which is the best evidence of what the reader reads.
 */
export const WalkthroughLanguagePicker = ({
  review,
  size = 'default',
  className,
}: {
  review: WalkthroughReview;
  size?: ControlSize;
  className?: string;
}) => {
  const { t, locales, label } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(dropdownTriggerVariants({ size }), 'min-w-0', className)}
          aria-label={t('walkthrough.language.selectorAria')}
          title={label(review.activeLanguage)}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <Icon name="global" className="shrink-0" />
            <span className="walkthrough-header__label truncate">{label(review.activeLanguage)}</span>
          </span>
          <Icon name="arrow-down-s" className="walkthrough-header__label" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-80 w-48 overflow-y-auto"
        positionerClassName={size === 'mobile' ? OVER_SHEET_POSITIONER_CLASS : undefined}
      >
        <DropdownMenuLabel className={MENU_GROUP_LABEL_CLASS}>
          {t('walkthrough.language.menuLabel')}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={review.activeLanguage}
          onValueChange={(value) => {
            setOpen(false);
            review.selectLanguage(value);
          }}
        >
          {locales.map((value: Locale) => (
            <DropdownMenuRadioItem key={value} value={value}>
              {label(value)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** Choosing a roomier model for a risky change is a per-review call, so this is review state rather than a settings edit. */
export const WalkthroughModelPicker = ({ review, className }: { review: WalkthroughReview; className?: string }) => (
  <ModelSelector
    providerId={review.activeProviderId ?? ''}
    modelId={review.activeModelId}
    onChange={review.selectModel}
    // While the auth list is loading, allow none — not every provider.
    allowedProviderIds={review.modelProviders ?? []}
    isModelAllowed={review.isStructuredOutputCapable}
    tooltipsEnabled={false}
    dropdownPortalToBody
    className={className}
  />
);

/** Generate, Regenerate or Cancel, whichever the walkthrough is ready for. */
export const WalkthroughGenerateButton = ({
  review,
  hasView,
  size = 'sm',
  className,
  labelClassName,
  onActed,
}: {
  review: WalkthroughReview;
  hasView: boolean;
  size?: 'sm' | 'lg';
  className?: string;
  /** Lets a tight toolbar drop the text and keep the icon. */
  labelClassName?: string;
  /** After the click, for a menu or sheet that should step aside. */
  onActed?: () => void;
}) => {
  const { t } = useI18n();
  if (review.isGenerating) {
    return (
      <Button
        type="button"
        variant="outline"
        size={size}
        className={className}
        aria-label={t('walkthrough.action.cancel')}
        title={t('walkthrough.action.cancel')}
        onClick={() => {
          review.cancel();
          onActed?.();
        }}
      >
        <Icon name="stop" className="size-3.5" />
        <span className={labelClassName}>{t('walkthrough.action.cancel')}</span>
      </Button>
    );
  }
  const text = hasView ? t('walkthrough.action.regenerate') : t('walkthrough.action.generate');
  return (
    <Button
      type="button"
      variant="outline"
      size={size}
      className={cn(review.generateDisabled ? 'border-border text-muted-foreground' : WALKTHROUGH_ACTION_CLASS, className)}
      disabled={review.generateDisabled}
      aria-label={text}
      title={text}
      onClick={() => {
        review.handleGenerate(hasView);
        onActed?.();
      }}
    >
      <Icon name={hasView ? 'refresh' : 'route'} className="size-3.5" />
      <span className={labelClassName}>{text}</span>
    </Button>
  );
};

/**
 * Where the reader is, and the whole list of steps to jump to. Shown where the
 * contents column is not, so position and what is ahead stay one tap away.
 */
export const WalkthroughStepMenu = ({
  review,
  view,
  size = 'default',
}: {
  review: WalkthroughReview;
  view: WalkthroughView;
  size?: ControlSize;
}) => {
  const { t } = useI18n();
  if (view.stops.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(dropdownTriggerVariants({ size }), 'shrink-0 tabular-nums')}
          aria-label={t('walkthrough.toc.jumpAria')}
        >
          <span dir="ltr">{`${review.activeStopPosition} / ${view.stops.length}`}</span>
          <Icon name="arrow-down-s" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-96 w-72 max-w-[calc(100vw-2rem)] overflow-y-auto">
        <DropdownMenuRadioGroup value={review.activeStopId ?? ''} onValueChange={review.handleSelectStop}>
          {view.chapters.map(({ chapter, stops }, index) => (
            <Fragment key={chapter.id}>
              {index > 0 && <DropdownMenuSeparator />}
              <DropdownMenuLabel className={MENU_GROUP_LABEL_CLASS}>
                <span className="block truncate">{chapter.title}</span>
              </DropdownMenuLabel>
              {stops.map((stopView) => (
                <DropdownMenuRadioItem key={stopView.stop.id} value={stopView.stop.id}>
                  <span className="w-5 shrink-0 tabular-nums text-muted-foreground">{stopView.position}</span>
                  <span className="min-w-0 truncate">{stopView.stop.title}</span>
                </DropdownMenuRadioItem>
              ))}
            </Fragment>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** Status of what is on screen: generating over it, asked in another language or model, outdated, or failed. */
export const WalkthroughBanners = ({ review, view }: { review: WalkthroughReview; view: WalkthroughView | null }) => {
  const { t, label } = useI18n();
  const { entry } = review;
  return (
    <>
      {/* While regenerating over an existing walkthrough the stream keeps showing
          the old content, so the only other signal would be the button swapping
          to Cancel — far too quiet for something that runs for tens of seconds. */}
      {review.isGenerating && view && (
        <div className="flex shrink-0 items-center gap-2 bg-[var(--status-info-background)] px-3 py-2">
          <Spinner className="size-4 shrink-0 text-[var(--status-info)]" />
          <span className="typography-meta text-foreground">
            {entry.stage === 'collecting'
              ? t('walkthrough.stage.collecting')
              : entry.stage === 'assembling'
                ? t('walkthrough.stage.assembling')
                : t('walkthrough.stage.asking')}
          </span>
        </div>
      )}

      {/* Switching the model or the language is a request for a walkthrough
          that may not exist yet. Falling back to the last one is better than an
          empty panel, but only if the panel says so — otherwise the picker
          claims Ukrainian over English prose. */}
      {(review.languageMissing || review.modelMissing) && (
        <div className="flex shrink-0 items-center gap-2 bg-[var(--status-info-background)] px-3 py-2">
          <Icon name="information" className="size-4 shrink-0 text-[var(--status-info)]" />
          <span className="typography-meta min-w-0 text-foreground">
            {review.languageMissing && review.modelMissing
              ? t('walkthrough.missing.languageAndModel')
              : review.languageMissing
                ? t('walkthrough.missing.language', {
                  requested: label(review.activeLanguage),
                  shown: label(review.shownLocale as Locale),
                })
                : t('walkthrough.missing.model', { model: review.activeModelId })}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="ms-auto shrink-0"
            disabled={review.generateDisabled}
            // Not forced: if an entry for this exact request existed the banner
            // would not be here, and a forced run would refuse the cache it may
            // find on the way.
            onClick={() => review.handleGenerate(false)}
          >
            {t('walkthrough.action.generate')}
          </Button>
        </div>
      )}

      {view?.isStale && !review.isGenerating && (
        <div className="flex shrink-0 items-center gap-2 bg-status-warning/10 px-3 py-2">
          <Icon name="error-warning" className="size-4 shrink-0 text-status-warning" />
          <span className="typography-meta min-w-0 text-foreground">
            {t('walkthrough.stale.banner', { count: view.staleStopCount })}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="ms-auto shrink-0"
            // Clicking this again mid-flight would abort the running generation
            // and start another — paying for the same answer twice.
            disabled={review.isGenerating}
            onClick={() => review.handleGenerate(true)}
          >
            {t('walkthrough.action.regenerate')}
          </Button>
        </div>
      )}

      {review.errorMessage && (
        <div className="flex shrink-0 items-start gap-2 bg-status-error/10 px-3 py-2">
          <Icon name="error-warning" className="mt-0.5 size-4 shrink-0 text-status-error" />
          {/* Provider errors arrive as raw JSON bodies. Show a readable amount
              and keep the rest reachable rather than filling the panel. */}
          <span className="typography-meta line-clamp-2 text-foreground" title={review.errorMessage}>
            {review.errorMessage}
          </span>
        </div>
      )}
    </>
  );
};

/**
 * Before the first walkthrough: what it is, what it is asked with, and the
 * button that starts it. The model and the language sit here because this is
 * the moment they are decided; once a walkthrough exists they are rarely
 * touched again and live in the header or its options.
 */
export const WalkthroughEmptyState = ({ review, size = 'default' }: { review: WalkthroughReview; size?: ControlSize }) => {
  const { t } = useI18n();
  if (review.entry.status === 'loading') {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <Icon name="loader-4" className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <Icon name="route" className="size-6 text-muted-foreground" />
      <h3 className="typography-ui-label font-semibold text-foreground">{t('walkthrough.empty.title')}</h3>
      <p className="typography-meta max-w-md text-muted-foreground">{t('walkthrough.empty.description')}</p>
      <div className={cn('flex max-w-full gap-2 pt-1', size === 'mobile' ? 'w-full flex-col' : 'flex-wrap items-center justify-center')}>
        <WalkthroughModelPicker review={review} className={size === 'mobile' ? undefined : 'max-w-48'} />
        <WalkthroughLanguagePicker review={review} size={size} className={size === 'mobile' ? 'w-full' : 'max-w-40'} />
      </div>
      <WalkthroughGenerateButton review={review} hasView={false} size={size === 'mobile' ? 'lg' : 'sm'} className={size === 'mobile' ? 'w-full' : undefined} />
    </div>
  );
};

/**
 * The controls a narrow header has no room for, gathered in one place: the
 * model, the language, Generate, and the guide. The desktop header opens it
 * from "More", the phone from its own options button.
 */
export const WalkthroughOptions = ({
  review,
  hasView,
  size = 'default',
  onOpenChanges,
  onActed,
}: {
  review: WalkthroughReview;
  hasView: boolean;
  size?: ControlSize;
  /** The pull request's Changes, when the header had to drop its button. */
  onOpenChanges?: () => void;
  /** After an action that leaves the options behind (Generate, Changes, the guide). */
  onActed?: () => void;
}) => {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <span className="typography-meta text-muted-foreground">{t('walkthrough.options.model')}</span>
        <WalkthroughModelPicker review={review} className={size === 'mobile' ? undefined : 'w-full max-w-none'} />
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="typography-meta text-muted-foreground">{t('walkthrough.options.language')}</span>
        <WalkthroughLanguagePicker review={review} size={size} className="w-full" />
      </div>
      <WalkthroughGenerateButton review={review} hasView={hasView} size={size === 'mobile' ? 'lg' : 'sm'} className="w-full" onActed={onActed} />
      {onOpenChanges && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-full"
          onClick={() => {
            onOpenChanges();
            onActed?.();
          }}
        >
          <Icon name="arrow-left-right" className="size-4" />
          {t('contextPanel.mode.diff')}
        </Button>
      )}
      <Button
        type="button"
        variant="ghost"
        size={size === 'mobile' ? 'lg' : 'sm'}
        className="w-full"
        onClick={() => {
          openWalkthroughGuide();
          onActed?.();
        }}
      >
        <Icon name="question" className="size-4" />
        {t('walkthrough.help.guide')}
      </Button>
    </div>
  );
};
