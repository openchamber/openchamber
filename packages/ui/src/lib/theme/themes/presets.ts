import type { Theme } from '@/types/theme';
import { withPrColors } from './prColors';

import amoled_dark_Raw from './amoled-dark.json';
import amoled_light_Raw from './amoled-light.json';
import aura_dark_Raw from './aura-dark.json';
import aura_light_Raw from './aura-light.json';
import ayu_dark_Raw from './ayu-dark.json';
import ayu_light_Raw from './ayu-light.json';
import carbonfox_dark_Raw from './carbonfox-dark.json';
import carbonfox_light_Raw from './carbonfox-light.json';
import catppuccin_dark_Raw from './catppuccin-dark.json';
import catppuccin_light_Raw from './catppuccin-light.json';
import cursor_dark_Raw from './cursor-dark.json';
import cursor_light_Raw from './cursor-light.json';
import dracula_dark_Raw from './dracula-dark.json';
import dracula_light_Raw from './dracula-light.json';
import github_dark_Raw from './github-dark.json';
import github_light_Raw from './github-light.json';
import gruvbox_dark_Raw from './gruvbox-dark.json';
import gruvbox_light_Raw from './gruvbox-light.json';
import kanagawa_dark_Raw from './kanagawa-dark.json';
import kanagawa_light_Raw from './kanagawa-light.json';
import lucent_orng_dark_Raw from './lucent-orng-dark.json';
import lucent_orng_light_Raw from './lucent-orng-light.json';
import monokai_dark_Raw from './monokai-dark.json';
import monokai_light_Raw from './monokai-light.json';
import nightowl_dark_Raw from './nightowl-dark.json';
import nightowl_light_Raw from './nightowl-light.json';
import nord_dark_Raw from './nord-dark.json';
import nord_light_Raw from './nord-light.json';
import oc_2_dark_Raw from './oc-2-dark.json';
import oc_2_light_Raw from './oc-2-light.json';
import openchamber_dark_Raw from './openchamber-dark.json';
import openchamber_light_Raw from './openchamber-light.json';
import onedarkpro_dark_Raw from './onedarkpro-dark.json';
import onedarkpro_light_Raw from './onedarkpro-light.json';
import orng_dark_Raw from './orng-dark.json';
import orng_light_Raw from './orng-light.json';
import rosepine_dark_Raw from './rosepine-dark.json';
import rosepine_light_Raw from './rosepine-light.json';
import shadesofpurple_dark_Raw from './shadesofpurple-dark.json';
import shadesofpurple_light_Raw from './shadesofpurple-light.json';
import solarized_dark_Raw from './solarized-dark.json';
import solarized_light_Raw from './solarized-light.json';
import tokyonight_dark_Raw from './tokyonight-dark.json';
import tokyonight_light_Raw from './tokyonight-light.json';
import vercel_dark_Raw from './vercel-dark.json';
import vercel_light_Raw from './vercel-light.json';
import vesper_dark_Raw from './vesper-dark.json';
import vesper_light_Raw from './vesper-light.json';
import zenburn_dark_Raw from './zenburn-dark.json';
import zenburn_light_Raw from './zenburn-light.json';
import mono_plus_dark_Raw from './mono-plus-dark.json';
import mono_plus_light_Raw from './mono-plus-light.json';
import mono_dark_Raw from './mono-dark.json';
import mono_light_Raw from './mono-light.json';
import vitesse_dark_dark_Raw from './vitesse-dark-dark.json';
import vitesse_light_light_Raw from './vitesse-light-light.json';

export const presetThemes: Theme[] = [
  openchamber_dark_Raw as Theme,
  openchamber_light_Raw as Theme,
  amoled_dark_Raw as Theme,
  amoled_light_Raw as Theme,
  aura_dark_Raw as Theme,
  aura_light_Raw as Theme,
  ayu_dark_Raw as Theme,
  ayu_light_Raw as Theme,
  carbonfox_dark_Raw as Theme,
  carbonfox_light_Raw as Theme,
  catppuccin_dark_Raw as Theme,
  catppuccin_light_Raw as Theme,
  cursor_dark_Raw as Theme,
  cursor_light_Raw as Theme,
  dracula_dark_Raw as Theme,
  dracula_light_Raw as Theme,
  github_dark_Raw as Theme,
  github_light_Raw as Theme,
  gruvbox_dark_Raw as Theme,
  gruvbox_light_Raw as Theme,
  kanagawa_dark_Raw as Theme,
  kanagawa_light_Raw as Theme,
  lucent_orng_dark_Raw as Theme,
  lucent_orng_light_Raw as Theme,
  monokai_dark_Raw as Theme,
  monokai_light_Raw as Theme,
  nightowl_dark_Raw as Theme,
  nightowl_light_Raw as Theme,
  nord_dark_Raw as Theme,
  nord_light_Raw as Theme,
  oc_2_dark_Raw as Theme,
  oc_2_light_Raw as Theme,
  onedarkpro_dark_Raw as Theme,
  onedarkpro_light_Raw as Theme,
  orng_dark_Raw as Theme,
  orng_light_Raw as Theme,
  rosepine_dark_Raw as Theme,
  rosepine_light_Raw as Theme,
  shadesofpurple_dark_Raw as Theme,
  shadesofpurple_light_Raw as Theme,
  solarized_dark_Raw as Theme,
  solarized_light_Raw as Theme,
  tokyonight_dark_Raw as Theme,
  tokyonight_light_Raw as Theme,
  vercel_dark_Raw as Theme,
  vercel_light_Raw as Theme,
  vesper_dark_Raw as Theme,
  vesper_light_Raw as Theme,
  zenburn_dark_Raw as Theme,
  zenburn_light_Raw as Theme,
  mono_plus_dark_Raw as Theme,
  mono_plus_light_Raw as Theme,
  mono_dark_Raw as Theme,
  mono_light_Raw as Theme,
  vitesse_dark_dark_Raw as Theme,
  vitesse_light_light_Raw as Theme,
].map((theme) => withPrColors(theme));
