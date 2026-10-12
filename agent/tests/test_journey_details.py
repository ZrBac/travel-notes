import copy
import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from travel_planner import DAY_SCHEMA, validate_day_details
from guide_visuals import compose


class JourneyDetailsTests(unittest.TestCase):
    def day(self):
        return {'day':1,'destination':'南京','theme':'慢游','stops':['老门东'],'transport':'步行','lunch':'本地小吃','dinner':'家常菜','stay':'市区','pace':'轻松',
                'waypoints':[{'name':'老门东','lat':32.012,'lng':118.789,'source':'https://example.com/coordinates'}],
                'slots':[{'period':p,'plan':'老城漫步','transport':'步行','reservation':'无需预约','start_time':'','end_time':'','booking_lead_days':None} for p in ('上午','下午','晚上')]}

    def test_schema_allows_unknown_map_and_time_without_fabrication(self):
        day=self.day();day['waypoints']=[];validate_day_details(day)
        self.assertIn('waypoints',DAY_SCHEMA['required'])
        self.assertEqual(DAY_SCHEMA['properties']['slots']['items']['properties']['booking_lead_days']['type'],['integer','null'])

    def test_coordinates_need_sources_and_booking_dates_reject_booleans(self):
        validate_day_details(self.day())
        for extra in ({'lat':True},{'lng':181},{'source':''},{'source':'javascript:alert(1)'},{'name':'其他景点'}):
            day=self.day();day['waypoints'][0].update(extra)
            with self.assertRaises(ValueError):validate_day_details(day)
        for extra in ({'booking_lead_days':True},{'booking_lead_days':181},{'start_time':'09:70'},{'start_time':'11:30','end_time':'10:30'}):
            day=self.day();day['slots'][0].update(extra)
            with self.assertRaises(ValueError):validate_day_details(day)

    def test_native_render_escapes_metadata_and_keeps_three_timeline_rows(self):
        day=self.day();day['stops']=['<img src=x onerror=alert(1)>'];day['waypoints']=[]
        guide={'template':'auto','country':'中国','planning_summary':'规划参考','itinerary':[day],'body':'## 说明\n待核实'}
        html=compose(guide,{})
        self.assertNotIn('<img src=x',html);self.assertIn('&lt;img',html)
        self.assertEqual(html.count('class="trip-timeline-item"'),3);self.assertIn('data-journey=',html)


if __name__=='__main__':unittest.main()
