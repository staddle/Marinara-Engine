import { useEffect } from "react";
import { Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { useUIStore } from "../../stores/ui.store";
import { translate } from "../../localization/i18n";

const CHIBI_PROFESSOR_MARI_IMAGE = "/sprites/mari/chibi-professor-mari.webp";
const SHINY_CHIBI_PROFESSOR_MARI_IMAGE = "/sprites/mari/chibi-professor-mari-shiny.webp";
const CHIBI_PROFESSOR_MARI_SEEN_KEY = "marinara:chibi-professor-mari-toast-seen";
const CHIBI_PROFESSOR_MARI_ROLL_CHANCE = 0.001;
/** Which look a rare visit gets; weights add up to 100. Pixel poses are 94x128, so they stay crisp. */
const CHIBI_PROFESSOR_MARI_VARIANTS = [
  {
    id: "normal",
    weight: 60,
    title: "ui.chibiProfessorMari.found.normal",
    src: CHIBI_PROFESSOR_MARI_IMAGE,
    className: "h-24 w-20",
  },
  {
    id: "mirrored",
    weight: 15,
    title: "ui.chibiProfessorMari.found.mirrored",
    src: CHIBI_PROFESSOR_MARI_IMAGE,
    className: "h-24 w-20 -scale-x-100",
  },
  {
    id: "upsideDown",
    weight: 10,
    title: "ui.chibiProfessorMari.found.upsideDown",
    src: CHIBI_PROFESSOR_MARI_IMAGE,
    className: "h-24 w-20 rotate-180",
  },
  {
    id: "dottore",
    weight: 7,
    title: "ui.chibiProfessorMari.found.dottore",
    src: "/sprites/mari/dottore/pose-chibi.webp",
    className: "h-32 w-24 [image-rendering:pixelated]",
  },
  {
    id: "gold",
    weight: 5,
    title: "ui.chibiProfessorMari.found.gold",
    src: "/sprites/mari/golden/pose-chibi.webp",
    className: "h-32 w-24 [image-rendering:pixelated]",
  },
  {
    id: "shiny",
    weight: 3,
    title: "ui.chibiProfessorMari.found.shiny",
    src: SHINY_CHIBI_PROFESSOR_MARI_IMAGE,
    className: "h-32 w-24",
  },
] as const;

function pickChibiProfessorMariVariant() {
  let roll = Math.random() * 100;
  return CHIBI_PROFESSOR_MARI_VARIANTS.find((v) => (roll -= v.weight) < 0) ?? CHIBI_PROFESSOR_MARI_VARIANTS[0];
}
const CHIBI_PROFESSOR_MARI_ROLL_COOLDOWN_MS = 3_000;
const CHIBI_PROFESSOR_MARI_TOAST_DURATION_MS = 18_000;

function hasSeenChibiProfessorMari() {
  try {
    return window.sessionStorage.getItem(CHIBI_PROFESSOR_MARI_SEEN_KEY) === "true";
  } catch {
    return false;
  }
}

function rememberChibiProfessorMari() {
  try {
    window.sessionStorage.setItem(CHIBI_PROFESSOR_MARI_SEEN_KEY, "true");
  } catch {
    // Ignore storage failures; the toast is still allowed to appear.
  }
}

function showChibiProfessorMariToast() {
  rememberChibiProfessorMari();
  const variant = pickChibiProfessorMariVariant();
  const shiny = variant.id === "shiny";
  toast.custom(
    (toastId) => (
      <div className={`relative flex max-w-[520px] flex-col gap-2 p-3 text-[var(--foreground)]`}>
        <button
          type="button"
          onClick={() => toast.dismiss(toastId)}
          className="absolute right-2 top-2 rounded-full p-1 text-foreground/45 transition-colors hover:bg-foreground/10 hover:text-foreground focus:outline-none focus:ring-2 focus:ring-[var(--primary)]/60"
          aria-label={translate("ui.chibiProfessorMari.dismiss")}
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        <p
          className={`px-8 text-center text-base font-bold ${shiny ? "bg-gradient-to-r from-slate-300 via-white to-sky-300 bg-clip-text text-transparent" : ""}`}
        >
          {translate(variant.title)}
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <div className="relative shrink-0 self-center">
            <img
              src={variant.src}
              alt={translate("ui.chibiProfessorMari.alt")}
              className={`${variant.className} object-contain drop-shadow-[0_4px_10px_rgb(0_0_0/0.25)]`}
              onError={(event) => {
                event.currentTarget.hidden = true;
              }}
            />
            {shiny && (
              <>
                <Sparkles
                  className="absolute -right-1 top-0 h-4 w-4 text-sky-200 motion-safe:animate-pulse"
                  aria-hidden="true"
                />
                <Sparkles
                  className="absolute -left-1 bottom-6 h-3 w-3 text-amber-200 motion-safe:animate-pulse"
                  aria-hidden="true"
                />
              </>
            )}
          </div>
          <div className="min-w-[10rem] flex-1 space-y-2 text-sm leading-relaxed">
            {shiny && <p className="font-bold text-sky-200">{translate("ui.chibiProfessorMari.shiny")}</p>}
            <p>{translate("ui.chibiProfessorMari.visit")}</p>
            <p>{translate("ui.chibiProfessorMari.fortune")}</p>
            <p>{translate("ui.chibiProfessorMari.loved")}</p>
          </div>
        </div>
      </div>
    ),
    {
      duration: CHIBI_PROFESSOR_MARI_TOAST_DURATION_MS,
      style: { width: "min(520px, calc(100vw - 32px))" },
    },
  );
}

export function ChibiProfessorMariEasterEgg() {
  const enabled = useUIStore((s) => s.chibiProfessorMariEnabled);

  useEffect(() => {
    if (!enabled) return;

    let seen = hasSeenChibiProfessorMari();
    let lastRollAt = 0;

    const handleScroll = () => {
      if (seen || document.visibilityState !== "visible") return;

      const now = Date.now();
      if (now - lastRollAt < CHIBI_PROFESSOR_MARI_ROLL_COOLDOWN_MS) return;
      lastRollAt = now;

      if (Math.random() > CHIBI_PROFESSOR_MARI_ROLL_CHANCE) return;

      seen = true;
      showChibiProfessorMariToast();
    };

    const scrollOptions: AddEventListenerOptions = { capture: true, passive: true };
    document.addEventListener("scroll", handleScroll, scrollOptions);

    return () => {
      document.removeEventListener("scroll", handleScroll, scrollOptions);
    };
  }, [enabled]);

  return null;
}
