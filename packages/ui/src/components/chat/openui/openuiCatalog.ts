import { openuiCatalogBase as openuiLibrary } from './openuiCatalog.schema';
import * as components from './openuiComponents';
import { ChamberGrid, ChamberGridItem } from './openuiGrid';
import { ChamberImage, ChamberImageGallery } from './openuiMedia';

if (!openuiLibrary.extend) throw new Error('OpenUI library extensions are unavailable');

/** One official catalog and store implementation, with application-owned adapters. */
export const chamberLibrary = openuiLibrary.extend({
  components: {
    override: [
      { ...openuiLibrary.components.HtmlView, component: components.ChamberHtmlView },
      { ...openuiLibrary.components.Grid, component: ChamberGrid },
      { ...openuiLibrary.components.GridItem, component: ChamberGridItem },
      { ...openuiLibrary.components.ImageGallery, component: ChamberImageGallery },
      { ...openuiLibrary.components.Carousel, component: components.ChamberCarousel },
      { ...openuiLibrary.components.Input, component: components.ChamberInput },
      { ...openuiLibrary.components.TextArea, component: components.ChamberTextArea },
      { ...openuiLibrary.components.Button, component: components.ChamberButton },
      { ...openuiLibrary.components.IconButton, component: components.ChamberIconButton },
      { ...openuiLibrary.components.TextContent, component: components.ChamberTextContent },
      { ...openuiLibrary.components.Callout, component: components.ChamberCallout },
      { ...openuiLibrary.components.Form, component: components.ChamberForm },
      { ...openuiLibrary.components.FormControl, component: components.ChamberFormControl },
      { ...openuiLibrary.components.Stack, component: components.ChamberStack },
      { ...openuiLibrary.components.Card, component: components.ChamberCard },
      { ...openuiLibrary.components.Tabs, component: components.ChamberTabs },
      { ...openuiLibrary.components.Accordion, component: components.ChamberAccordion },
      { ...openuiLibrary.components.Select, component: components.ChamberSelect },
      { ...openuiLibrary.components.CheckBoxGroup, component: components.ChamberCheckBoxGroup },
      { ...openuiLibrary.components.SwitchGroup, component: components.ChamberSwitchGroup },
      { ...openuiLibrary.components.Icon, component: components.OpenUIIcon },
      { ...openuiLibrary.components.Tag, component: components.ChamberTag },
      { ...openuiLibrary.components.Image, component: ChamberImage },
      { ...openuiLibrary.components.Chips, component: components.ChamberChips },
      { ...openuiLibrary.components.OptionCards, component: components.ChamberOptionCards },
      { ...openuiLibrary.components.Table, component: components.ChamberTable },
      { ...openuiLibrary.components.RadioGroup, component: components.ChamberRadioGroup },
      { ...openuiLibrary.components.DatePicker, component: components.ChamberDatePicker },
      { ...openuiLibrary.components.Slider, component: components.ChamberSlider },
      { ...openuiLibrary.components.BarChart, component: components.ChamberBarChart },
      { ...openuiLibrary.components.LineChart, component: components.ChamberLineChart },
      { ...openuiLibrary.components.AreaChart, component: components.ChamberAreaChart },
      { ...openuiLibrary.components.PieChart, component: components.ChamberPieChart },
    ],
  },
});
