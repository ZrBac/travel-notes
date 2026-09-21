import unittest
import test_app
from app import render_markdown
from travel_publication import budget_summary,money_range,split_guides
from test_travel_publication import comparison

def budget(total='1800～2700元',group='16200～24300元'):
 return '''| 项目 | 人均 | 团队合计 | 范围 |
|---|---|---|---|
| 住宿 | 900～1500元 | 8100～13500元 | 9间×3晚 |
| 交通 | 300～400元 | 2700～3600元 | 市内 |
| 餐饮 | 400～500元 | 3600～4500元 | 四天 |
| 门票活动 | 100～200元 | 900～1800元 | 景区 |
| 预备金 | 100元 | 900元 | 预留 |
| 合计 | '''+total+' | '+group+''' | 不含往返大交通 |
'''

class BudgetTests(unittest.TestCase):
 def test_numeric_ranges_and_metadata(self):
  self.assertEqual(budget_summary(budget(),9,render_markdown),'人均1800～2700元；团队16200～24300元，不含往返大交通')
  self.assertIsNone(money_range('视房态而定，300美元'))
  self.assertIsNone(money_range('9间×3晚×300元'))
  self.assertEqual(money_range('￥1,200～1,800元/人'),(1200,1800))
  with self.assertRaises(ValueError):money_range('500～100元')
 def test_bad_total_or_party_multiplier_blocks_publication(self):
  with self.assertRaisesRegex(ValueError,'分项加总'):budget_summary(budget('2000～2700元','18000～24300元'),9,render_markdown)
  with self.assertRaisesRegex(ValueError,'人数'):budget_summary(budget(),8,render_markdown)
  with self.assertRaisesRegex(ValueError,'人数'):budget_summary(budget(group='16000～24300元'),9,render_markdown)
 def test_unpriced_rows_are_not_misrepresented_as_verified_totals(self):
  value=budget().replace('900～1500元','待核实')
  self.assertIsNotNone(budget_summary(value,9,render_markdown))
  self.assertIsNone(budget_summary('待确认酒店报价',9,render_markdown))
 def test_split_extracts_each_budget_and_cleans_legacy_card_links(self):
  g=comparison();g['body']=g['body'].replace('### 住宿和预算','### 预算\n\n'+budget()+'\n\n### 住宿和预算')
  g['body']=g['body'].replace('泉州特色介绍</p>','泉州特色[官方资料](https://example.com/info)</p>').replace('D1 · 泉州</h3>','D1 · 泉州｜文档一·D1｜抵达</h3>')
  g['highlights'][0]['description']='泉州特色[官方资料](https://example.com/info)'
  result=split_guides(g,{'people':9},render_markdown)
  for row in result:self.assertIn('1800～2700',row['budget'])
  self.assertNotIn('文档一',result[0]['body']);self.assertNotIn('](',result[0]['summary']);self.assertIn('href="https://example.com/info"',result[0]['body'])
  g['body']=g['body'].replace('| 合计 | 1800～2700元 | 16200～24300元','| 合计 | 2000～2700元 | 18000～24300元')
  with self.assertRaisesRegex(ValueError,'分项加总'):split_guides(g,{'people':9},render_markdown)
