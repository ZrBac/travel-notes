"""Map provenance, native-guide adoption, itinerary times and movable preparation dates."""
import copy
import importlib.util
from pathlib import Path
import unittest
from database import connect
import test_trips as fixture


def detailed_plan():
    plan=fixture.itinerary()
    for day in plan:
        day['waypoints']=[{'name':day['stops'][0],'lat':32.012,'lng':118.789,'source':'https://example.com/coordinates'}]
        for slot in day['slots']:slot.update(start_time='',end_time='',booking_lead_days=None)
        day['slots'][0].update(start_time='09:30',end_time='11:30',booking_lead_days=7)
    return plan


class JourneyDetailsTests(unittest.TestCase):
    setUp=fixture.TripTests.setUp
    login=fixture.TripTests.login
    mutate=fixture.TripTests.mutate
    new_trip=fixture.TripTests.new_trip
    get=fixture.TripTests.get
    task=fixture.TripTests.task
    adopt=fixture.TripTests.adopt
    create_guide=fixture.TripTests.create_guide
    def test_native_timeline_roundtrip_and_optional_legacy_fields(self):
        self.login()
        spec=importlib.util.spec_from_file_location('test_native_guide_visuals',Path(__file__).resolve().parents[1]/'agent/guide_visuals.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        plan=detailed_plan()
        guide={'template':'auto','destination':'南京','country':'中国','planning_summary':'参考路线','itinerary':plan,'body':'## 住宿\n老城附近'}
        body=module.compose(guide,{})
        stored=self.create_guide(destination='南京',days=2,body=body)
        html=stored['html']
        self.assertIn('data-journey=',html);self.assertIn('trip-timeline-item',html);self.assertIn('09:30',html)
        preview=self.client.get(f"/api/admin/trips/source?guide_id={stored['id']}")
        self.assertEqual(preview.status_code,200,preview.json)
        adopted=preview.json['plan']['itinerary']
        self.assertEqual(adopted[0]['stops'],plan[0]['stops'])
        self.assertEqual(adopted[0]['waypoints'],plan[0]['waypoints'])
        self.assertEqual(adopted[0]['slots'],plan[0]['slots'])
        self.assertEqual(adopted[0]['lunch'],plan[0]['lunch'])
        tid=self.new_trip(source=preview.json['source'])['trip']['id']
        self.assertEqual(self.get(tid)['plan']['snapshot']['itinerary'][0]['waypoints'],plan[0]['waypoints'])
        old=self.new_trip()['trip']['id'];task=self.task()
        self.assertEqual(self.adopt(old,{'task_id':task}).status_code,200)
        self.assertNotIn('waypoints',self.get(old)['plan']['snapshot']['itinerary'][0])

    def test_missing_sources_invalid_coordinates_and_times_reject_without_new_version(self):
        self.login();trip=self.new_trip(source={'task_id':self.task()});tid=trip['trip']['id'];revision=trip['trip']['revision']
        invalids=[]
        for extra in ({'lat':True},{'lat':91},{'lng':float('nan')},{'source':'javascript:alert(1)'},{'source':'https://user:pass@example.com/'},{'name':'其他地点'}):
            plan=detailed_plan();plan[0]['waypoints'][0].update(extra);invalids.append(plan)
        plan=detailed_plan();plan[0]['waypoints']*=2;invalids.append(plan)
        for extra in ({'start_time':'25:00'},{'start_time':'12:00','end_time':'10:00'},{'booking_lead_days':True},{'booking_lead_days':181}):
            plan=detailed_plan();plan[0]['slots'][0].update(extra);invalids.append(plan)
        for plan in invalids:
            response=self.mutate('POST',f'/api/admin/trips/{tid}/plan',{'revision':revision,'itinerary':plan})
            self.assertEqual(response.status_code,400,response.json)
        self.assertEqual(self.get(tid)['plan']['version'],1)
        self.assertEqual(self.get(tid)['trip']['revision'],revision)

    def test_suggested_dates_follow_trip_date_and_manual_dates_override_without_losing_completion(self):
        self.login();trip=self.new_trip()['trip'];tid=trip['id']
        saved=self.mutate('POST',f'/api/admin/trips/{tid}/plan',{'revision':trip['revision'],'itinerary':detailed_plan()})
        self.assertEqual(saved.status_code,200,saved.json)
        trip=self.get(tid)['trip'];item=next(i for i in trip['checklist'] if i['kind']=='reservation' and i['day']==1)
        self.assertEqual(item['suggested_date'],'2026-10-30')
        marked=self.mutate('POST',f'/api/admin/trips/{tid}/checklist',{'revision':trip['revision'],'action':'update','id':item['id'],'done':True,'due_date':'2026-10-28'})
        self.assertEqual(marked.status_code,200)
        changed=self.mutate('PUT',f'/api/admin/trips/{tid}',{'revision':marked.json['revision'],'start_date':'2026-11-13','end_date':'2026-11-14'})
        self.assertEqual(changed.status_code,200,changed.json)
        current=next(i for i in changed.json['trip']['checklist'] if i['id']==item['id'])
        self.assertEqual(current['suggested_date'],'2026-11-06');self.assertEqual(current['due_date'],'2026-10-28');self.assertTrue(current['done'])
        for value in ('2026-02-30',False,[],123):
            bad=self.mutate('POST',f'/api/admin/trips/{tid}/checklist',{'revision':changed.json['revision'],'action':'update','id':item['id'],'due_date':value})
            self.assertEqual(bad.status_code,400)
        cleared=self.mutate('POST',f'/api/admin/trips/{tid}/checklist',{'revision':changed.json['revision'],'action':'update','id':item['id'],'due_date':''})
        self.assertEqual(cleared.status_code,200)
        current=next(i for i in cleared.json['checklist'] if i['id']==item['id']);self.assertIsNone(current['due_date']);self.assertEqual(current['suggested_date'],'2026-11-06')
        with connect() as conn:
            row=conn.execute('SELECT checklist FROM trips WHERE id=%s',(tid,)).fetchone()
            self.assertTrue(all('suggested_date' not in i for i in row['checklist']),'computed dates are never persisted into user data')


if __name__=='__main__':unittest.main()
