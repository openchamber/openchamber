import type { Theme } from '@/types/theme';
import { withPrColors } from './prColors';

import aura_dark_Raw from './aura-dark.json';
import aura_light_Raw from './aura-light.json';
import ayu_dark_Raw from './ayu-dark.json';
import ayu_light_Raw from './ayu-light.json';
import carbonfox_dark_Raw from './carbonfox-dark.json';
import carbonfox_light_Raw from './carbonfox-light.json';
import catppuccin_dark_Raw from './catppuccin-dark.json';
import catppuccin_light_Raw from './catppuccin-light.json';
import dracula_dark_Raw from './dracula-dark.json';
import dracula_light_Raw from './dracula-light.json';
import gruvbox_dark_Raw from './gruvbox-dark.json';
import gruvbox_light_Raw from './gruvbox-light.json';
import jetbrains_dark_Raw from './jetbrains-dark.json';
import jetbrains_light_Raw from './jetbrains-light.json';
import kanagawa_dark_Raw from './kanagawa-dark.json';
import kanagawa_light_Raw from './kanagawa-light.json';
import monokai_dark_Raw from './monokai-dark.json';
import monokai_light_Raw from './monokai-light.json';
import nightowl_dark_Raw from './nightowl-dark.json';
import nightowl_light_Raw from './nightowl-light.json';
import nord_dark_Raw from './nord-dark.json';
import nord_light_Raw from './nord-light.json';
import fields_of_the_shire_dark_Raw from './fields-of-the-shire-dark.json';
import fields_of_the_shire_light_Raw from './fields-of-the-shire-light.json';
import onedarkpro_dark_Raw from './onedarkpro-dark.json';
import onedarkpro_light_Raw from './onedarkpro-light.json';
import solarized_dark_Raw from './solarized-dark.json';
import solarized_light_Raw from './solarized-light.json';
import tokyonight_dark_Raw from './tokyonight-dark.json';
import tokyonight_light_Raw from './tokyonight-light.json';
import vesper_dark_Raw from './vesper-dark.json';
import vesper_light_Raw from './vesper-light.json';
import mono_plus_dark_Raw from './mono-plus-dark.json';
import mono_plus_light_Raw from './mono-plus-light.json';
import mono_dark_Raw from './mono-dark.json';
import mono_light_Raw from './mono-light.json';
import vitesse_dark_dark_Raw from './vitesse-dark-dark.json';
import vitesse_light_light_Raw from './vitesse-light-light.json';

export const presetThemes: Theme[] = [
  fields_of_the_shire_dark_Raw as Theme,
  fields_of_the_shire_light_Raw as Theme,
  aura_dark_Raw as Theme,
  aura_light_Raw as Theme,
  ayu_dark_Raw as Theme,
  ayu_light_Raw as Theme,
  carbonfox_dark_Raw as Theme,
  carbonfox_light_Raw as Theme,
  catppuccin_dark_Raw as Theme,
  catppuccin_light_Raw as Theme,
  dracula_dark_Raw as Theme,
  dracula_light_Raw as Theme,
  gruvbox_dark_Raw as Theme,
  gruvbox_light_Raw as Theme,
  jetbrains_dark_Raw as Theme,
  jetbrains_light_Raw as Theme,
  kanagawa_dark_Raw as Theme,
  kanagawa_light_Raw as Theme,
  monokai_dark_Raw as Theme,
  monokai_light_Raw as Theme,
  nightowl_dark_Raw as Theme,
  nightowl_light_Raw as Theme,
  nord_dark_Raw as Theme,
  nord_light_Raw as Theme,
  onedarkpro_dark_Raw as Theme,
  onedarkpro_light_Raw as Theme,
  solarized_dark_Raw as Theme,
  solarized_light_Raw as Theme,
  tokyonight_dark_Raw as Theme,
  tokyonight_light_Raw as Theme,
  vesper_dark_Raw as Theme,
  vesper_light_Raw as Theme,
  mono_plus_dark_Raw as Theme,
  mono_plus_light_Raw as Theme,
  mono_dark_Raw as Theme,
  mono_light_Raw as Theme,
  vitesse_dark_dark_Raw as Theme,
  vitesse_light_light_Raw as Theme,
].map((theme) => withPrColors(theme));
