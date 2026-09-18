import type { Theme } from '@/types/theme';
import { withPrColors } from './prColors';
import { requireTheme } from '../definition';

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
  fields_of_the_shire_dark_Raw,
  fields_of_the_shire_light_Raw,
  aura_dark_Raw,
  aura_light_Raw,
  ayu_dark_Raw,
  ayu_light_Raw,
  carbonfox_dark_Raw,
  carbonfox_light_Raw,
  catppuccin_dark_Raw,
  catppuccin_light_Raw,
  dracula_dark_Raw,
  dracula_light_Raw,
  gruvbox_dark_Raw,
  gruvbox_light_Raw,
  jetbrains_dark_Raw,
  jetbrains_light_Raw,
  kanagawa_dark_Raw,
  kanagawa_light_Raw,
  monokai_dark_Raw,
  monokai_light_Raw,
  nightowl_dark_Raw,
  nightowl_light_Raw,
  nord_dark_Raw,
  nord_light_Raw,
  onedarkpro_dark_Raw,
  onedarkpro_light_Raw,
  solarized_dark_Raw,
  solarized_light_Raw,
  tokyonight_dark_Raw,
  tokyonight_light_Raw,
  vesper_dark_Raw,
  vesper_light_Raw,
  mono_plus_dark_Raw,
  mono_plus_light_Raw,
  mono_dark_Raw,
  mono_light_Raw,
  vitesse_dark_dark_Raw,
  vitesse_light_light_Raw,
].map((theme) => withPrColors(requireTheme(theme)));
