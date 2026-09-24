from pathlib import Path
import re, json, html, textwrap, math
from reportlab.pdfgen import canvas
from reportlab.platypus import (BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer,
    PageBreak, Table, TableStyle, KeepTogether, Flowable, NextPageTemplate)
from reportlab.platypus.tableofcontents import TableOfContents
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from pypdf import PdfReader, PdfWriter

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'output' / 'pdf'
OUT.mkdir(parents=True, exist_ok=True)
TMP = ROOT / 'tmp' / 'pdfs'
PDF = OUT / 'DWH-SQL-Assistant-Architecture.pdf'
FONTS = Path('C:/Windows/Fonts')
for name, fn in [('Body','segoeui.ttf'),('BodyBold','segoeuib.ttf'),('BodyItalic','segoeuii.ttf'),('Mono','consola.ttf')]:
    pdfmetrics.registerFont(TTFont(name, str(FONTS / fn)))
pdfmetrics.registerFontFamily('Body', normal='Body', bold='BodyBold', italic='BodyItalic', boldItalic='BodyBold')

NAVY = colors.HexColor('#142D44')
TEAL = colors.HexColor('#087E8B')
INK = colors.HexColor('#253B4C')
GRAY = colors.HexColor('#5D7181')
PALE = colors.HexColor('#EDF5F6')
LINE = colors.HexColor('#D7E3E8')
AMBER = colors.HexColor('#A96C14')
W,H = A4
M=45
CW=W-2*M

S={}
S['body']=ParagraphStyle('Body',fontName='Body',fontSize=9.2,leading=13.2,textColor=INK,spaceAfter=7)
S['small']=ParagraphStyle('Small',parent=S['body'],fontSize=8,leading=11,spaceAfter=5)
S['h1']=ParagraphStyle('H1',fontName='BodyBold',fontSize=24,leading=29,textColor=NAVY,spaceAfter=15,keepWithNext=True)
S['h2']=ParagraphStyle('H2',fontName='BodyBold',fontSize=14,leading=18,textColor=NAVY,spaceBefore=16,spaceAfter=9,keepWithNext=True)
S['h3']=ParagraphStyle('H3',fontName='BodyBold',fontSize=10.6,leading=14,textColor=TEAL,spaceBefore=10,spaceAfter=6,keepWithNext=True)
S['table']=ParagraphStyle('Table',parent=S['body'],fontSize=8,leading=11,spaceAfter=0,splitLongWords=True)
S['th']=ParagraphStyle('TH',parent=S['table'],fontName='BodyBold',textColor=colors.white)
S['code']=ParagraphStyle('Code',fontName='Mono',fontSize=7.25,leading=10,textColor=INK,spaceAfter=0)
S['caption']=ParagraphStyle('Caption',parent=S['small'],textColor=GRAY,spaceBefore=6,spaceAfter=11)
S['bullet']=ParagraphStyle('Bullet',parent=S['body'],leftIndent=12,firstLineIndent=-9)
S['toc0']=ParagraphStyle('TOC0',fontName='BodyBold',fontSize=10,leading=13.5,textColor=NAVY,spaceBefore=8,spaceAfter=3)
S['toc1']=ParagraphStyle('TOC1',fontName='Body',fontSize=8.2,leading=11.2,textColor=INK,leftIndent=12,firstLineIndent=0,spaceAfter=1)

def norm(s):
    return str(s).replace('\u2011','-').replace('\u2013','-').replace('\u2014',' - ').replace('\u2212','-').replace('\u00a0',' ').replace('\u2019',"'").replace('\u2018',"'").replace('\u201c','"').replace('\u201d','"')

def inline(s):
    s=norm(s)
    held=[]
    def hold(v):
        held.append(v); return f'ZZTOKEN{len(held)-1}ZZ'
    def link(m):
        label,url=m.group(1),m.group(2).strip('<>')
        label=html.escape(label)
        if url.startswith('http'):
            return hold(f'<link href="{html.escape(url,quote=True)}" color="#087E8B">{label}</link>')
        targets={'minimal-logical-architecture.md':'part1','elasticsearch-metadata-model.md':'part2','logical-architecture.md':'part3','elasticsearch-index-mapping.json':'appa','elasticsearch-sample-documents.json':'appb'}
        name=url.replace('\\','/').split('/')[-1]
        if name in targets:
            return hold(f'<link href="#{targets[name]}" color="#087E8B">{label}</link>')
        return label
    s=re.sub(r'\[([^\]]+)\]\((<[^>]+>|[^)]+)\)',link,s)
    s=re.sub(r'`([^`]+)`',lambda m:hold('<font name="Mono" size="8">'+html.escape(m.group(1))+'</font>'),s)
    s=html.escape(s)
    s=re.sub(r'\*\*([^*]+)\*\*',r'<b>\1</b>',s)
    for i,v in enumerate(held): s=s.replace(f'ZZTOKEN{i}ZZ',v)
    return s

def p(t,style='body'):return Paragraph(inline(t),S[style])

class Banner(Flowable):
    def __init__(self,text,accent=TEAL):
        Flowable.__init__(self);self.text=text;self.accent=accent;self.width=CW;self.para=Paragraph(inline(text),S['body'])
    def wrap(self,a,b):
        self.ph=self.para.wrap(CW-28,b)[1];self.height=self.ph+21;return self.width,self.height
    def draw(self):
        c=self.canv;c.setFillColor(PALE);c.roundRect(0,0,CW,self.height,5,fill=1,stroke=0)
        c.setFillColor(self.accent);c.rect(0,0,3,self.height,fill=1,stroke=0)
        self.para.drawOn(c,14,11)

class Diagram(Flowable):
    def __init__(self,kind):
        Flowable.__init__(self);self.kind=kind;self.width=CW
        self.height={'minimal':345,'sequence':332,'data':248,'full':372,'er':230}[kind]
    def draw(self):
        c=self.canv
        def txt(x,y,w,t,size=8.1,bold=False,color=INK):
            st=ParagraphStyle('d',fontName='BodyBold' if bold else 'Body',fontSize=size,leading=size+2.4,textColor=color,alignment=1)
            q=Paragraph(html.escape(norm(t)).replace('\n','<br/>'),st);pw,ph=q.wrap(w-12,80);q.drawOn(c,x+6,y-ph)
        def box(x,y,w,h,title,sub='',accent=False):
            c.setFillColor(NAVY if accent else PALE);c.setStrokeColor(LINE);c.roundRect(x,y,w,h,6,fill=1,stroke=0 if accent else 1)
            txt(x,y+h-10,w,title,8.8,True,colors.white if accent else NAVY)
            if sub:txt(x,y+h-27,w,sub,7.6,False,colors.HexColor('#DFEBF0') if accent else GRAY)
        def arrow(points,label=None,lx=None,ly=None):
            c.setStrokeColor(TEAL);c.setLineWidth(1.25)
            path=c.beginPath();path.moveTo(*points[0])
            for pt in points[1:]:path.lineTo(*pt)
            c.drawPath(path)
            (x0,y0),(x,y)=points[-2:];ang=math.atan2(y-y0,x-x0)
            path=c.beginPath();path.moveTo(x,y)
            for a in [ang+2.6,ang-2.6]:path.lineTo(x+5*math.cos(a),y+5*math.sin(a))
            path.close();c.setFillColor(TEAL);c.drawPath(path,fill=1,stroke=0)
            if label:txt(lx,ly,100,label,7.1)
        if self.kind=='minimal':
            box(0,282,151,58,'Oracle metadata','PowerDesigner + Accurity')
            box(177,282,151,58,'Reviewed content','Join rules + SQL examples')
            box(354,282,151,58,'Preparation job','Format + local embeddings')
            arrow([(151,311),(165,311),(165,271),(430,271),(430,282)])
            arrow([(328,311),(354,311)])
            box(354,180,151,61,'Elasticsearch','Metadata + vectors')
            arrow([(430,282),(430,241)])
            box(0,180,151,61,'Web interface','Question + SQL editor')
            box(177,180,151,61,'Application backend','Retrieval + prompting\nBasic checks',True)
            arrow([(151,213),(177,213)])
            arrow([(328,213),(354,213)])
            box(177,74,151,64,'Local LLM on A100','One generative model',True)
            arrow([(242,180),(242,138)])
            arrow([(264,138),(264,180)])
            box(0,0,151,56,'Power user','Review and copy SQL')
            arrow([(75,180),(75,56)])
            box(177,0,151,56,'Existing SQL client','Manual execution')
            box(354,0,151,56,'Target DWH','Existing permissions')
            arrow([(151,28),(177,28)]);arrow([(328,28),(354,28)])
            txt(348,155,157,'Encoder runs locally on CPU; no cloud inference.',7.6)
        elif self.kind=='sequence':
            stages=[('01','Receive request','Question, domain, optional existing SQL'),('02','Retrieve context','Keyword + vector search; complete dependencies'),('03','Build prompt','Relevant schema, guidance, examples and dialect'),('04','Generate once','Local A100 model returns draft or clarification'),('05','Check response','Parse SQL, resolve identifiers, verify source IDs'),('06','Return for review','SQL, interpretation, assumptions and findings')]
            for i,(n,t,sub) in enumerate(stages):
                y=282-i*51
                c.setFillColor(TEAL);c.circle(17,y+23,14,fill=1,stroke=0)
                txt(1,y+30,32,n,8.5,True,colors.white)
                box(45,y,CW-70,44,t,sub)
                if i<5:arrow([(17,y+8),(17,y-13)])
            txt(55,17,CW-80,'Clarification or follow-up starts another bounded request. No automatic execution.',8)
        elif self.kind=='data':
            box(177,184,151,58,'Example document','Question + reviewed SQL',True)
            box(0,90,151,58,'Guidance document','Joins + business rules')
            box(177,90,151,58,'Table: invoices','Schema + columns')
            box(354,90,151,58,'Table: customers','Schema + columns')
            arrow([(210,184),(75,160),(75,148)])
            arrow([(252,184),(252,148)])
            arrow([(290,184),(430,160),(430,148)])
            arrow([(151,118),(177,118)])
            box(177,0,328,55,'Embedded glossary mappings','Column ID -> term ID, definition and aliases')
            arrow([(252,90),(252,55)]);arrow([(430,90),(430,55)])
            txt(0,65,153,'Dependencies are IDs.\nNo Elasticsearch joins.',7.8)
        elif self.kind=='full':
            box(0,310,505,58,'Metadata publication','Sources -> normalization -> versioned catalog -> embeddings -> Elasticsearch')
            box(0,224,151,61,'Identity + API','Scope and request envelope')
            box(177,224,151,61,'Orchestrator','State, versions, deadlines',True)
            box(354,224,151,61,'Retrieval + linker','Candidate schema and terms')
            arrow([(252,310),(252,285)])
            arrow([(151,254),(177,254)]);arrow([(328,254),(354,254)])
            box(354,132,151,61,'Semantic planner','Metrics, joins, grain, dates')
            box(177,132,151,61,'Context + A100','Bounded plan proposal',True)
            box(0,132,151,61,'Compiler + validator','Supported plan to SQL')
            arrow([(430,224),(430,193)]);arrow([(354,162),(328,162)]);arrow([(177,162),(151,162)])
            box(0,44,151,61,'Review artifact','SQL, sources, findings')
            box(177,44,151,61,'Optional execution','Revalidate + restricted DB')
            box(354,44,151,61,'Target DWH','Prepare / explain / results')
            arrow([(75,132),(75,105)]);arrow([(151,74),(177,74)]);arrow([(328,74),(354,74)])
            txt(0,24,505,'Shared controls: policy | secrets | audit | evaluation | configuration registry',8.5)
        elif self.kind=='er':
            box(0,160,151,58,'Business terms','IDs, meanings, aliases')
            box(177,160,151,58,'Term bindings','Column or expression')
            box(354,160,151,58,'Physical objects','Tables, columns, keys')
            arrow([(151,190),(177,190)]);arrow([(328,190),(354,190)])
            box(0,65,151,58,'Domains + metrics','Scope, formulas and grain')
            box(177,65,151,58,'Rules + relationships','Filters, dates and joins')
            box(354,65,151,58,'Release manifest','Pins all record versions')
            arrow([(75,160),(75,123)]);arrow([(252,160),(252,123)]);arrow([(430,160),(430,123)])
            txt(0,36,505,'Reference architecture only: these entities are not separate MVP services.',8.5)

class Report(BaseDocTemplate):
    def __init__(self,path):
        super().__init__(str(path),pagesize=A4,leftMargin=M,rightMargin=M,topMargin=53,bottomMargin=44,title='DWH SQL Assistant | POC / MVP Architecture and Metadata Model',author='Architecture working document')
        frame=Frame(M,44,CW,H-99,id='body',leftPadding=0,rightPadding=0,topPadding=0,bottomPadding=0)
        self.addPageTemplates([PageTemplate(id='cover',frames=[frame],onPage=self.cover_page),PageTemplate(id='normal',frames=[frame],onPage=self.normal_page)])
        self.section='Architecture & metadata model';self.entries=[]
    def cover_page(self,c,doc):pass
    def normal_page(self,c,doc):
        c.saveState();c.setFillColor(TEAL);c.rect(M,H-31,23,3,fill=1,stroke=0)
        c.setFont('BodyBold',8);c.setFillColor(NAVY);c.drawString(M+32,H-31,'DWH SQL ASSISTANT')
        c.setFont('Body',7.5);c.setFillColor(GRAY);c.drawRightString(W-M,H-31,'POC / MVP DESIGN')
        c.setStrokeColor(LINE);c.line(M,31,W-M,31)
        c.setFont('Body',7);c.drawString(M,19,'23 September 2026  |  On-premises architecture')
        c.drawRightString(W-M,19,f'{doc.page:02d}')
        c.restoreState()
    def afterFlowable(self,f):
        if isinstance(f,Paragraph) and hasattr(f,'bookmark'):
            key=f.bookmark;self.canv.bookmarkPage(key)
            level=f.toclevel;label=f.getPlainText()
            self.canv.addOutlineEntry(label,key,level=level,closed=False)
            if getattr(f,'include_toc',True):self.notify('TOCEntry',(level,label,self.page,key))

class Cover(Flowable):
    def __init__(self):Flowable.__init__(self);self.width=CW;self.height=H-101
    def draw(self):
        c=self.canv;c.saveState()
        # Full-bleed treatment stays within the canvas using frame-relative coordinates.
        c.setFillColor(NAVY);c.rect(-M,-44,W,H,fill=1,stroke=0)
        c.setFillColor(TEAL);c.rect(-M,-44,12,H,fill=1,stroke=0)
        c.setFillColor(colors.HexColor('#25465C'));c.circle(470,535,125,fill=1,stroke=0)
        c.setFillColor(colors.HexColor('#1C3A50'));c.circle(445,535,88,fill=1,stroke=0)
        def cp(t,y,size=14,font='Body',color=colors.white,width=CW):
            st=ParagraphStyle('cover',fontName=font,fontSize=size,leading=size*1.17,textColor=color)
            q=Paragraph(t,st);_,h=q.wrap(width,300);q.drawOn(c,0,y-h)
        cp('ARCHITECTURE / DESIGN DOSSIER',680,10,'BodyBold',colors.HexColor('#82D6D6'))
        cp('DWH SQL<br/>Drafting Assistant',604,39,'BodyBold')
        cp('POC / MVP architecture<br/>and Elasticsearch metadata model',473,21,'Body',colors.HexColor('#DDE9EF'))
        cp('From business questions to reviewable SQL.',386,13,'Body',colors.HexColor('#BBD0DD'))
        c.setStrokeColor(colors.HexColor('#476274'));c.line(0,323,CW,323)
        for i,(a,b) in enumerate([('LOCAL INFERENCE','One A100'),('RETRIEVAL','Elasticsearch'),('METADATA','PowerDesigner + Accurity')]):
            x=i*170;c.setFont('BodyBold',8);c.setFillColor(colors.HexColor('#82D6D6'));c.drawString(x,292,a)
            c.setFont('Body',10);c.setFillColor(colors.white);c.drawString(x,272,b)
        cp('Agreed implementation scope: a small SQL drafting application.<br/>The broader architecture is retained as a reference appendix.',211,11,'Body',colors.HexColor('#DDE9EF'))
        cp('23 September 2026<br/>Proposed design - no live deployment performed',94,9,'Body',colors.HexColor('#AFC6D5'))
        c.restoreState()

counter=0
def heading(t,level=1,key=None):
    global counter
    counter+=1
    q=p(t,'h1' if level==0 else 'h2');q.bookmark=key or f'section-{counter}';q.toclevel=level
    return q

def code_block(code,lang=''):
    result=[]
    # Wrap display lines, while keeping all text. Machine-readable originals are attached.
    for line in norm(code).splitlines():
        if not line:result.append(' ');continue
        indent=len(line)-len(line.lstrip())
        lim=106
        if len(line)<=lim:result.append(line)
        else:result.extend(textwrap.wrap(line,width=lim,initial_indent='',subsequent_indent=' '*min(indent+2,16),break_long_words=True,break_on_hyphens=False,replace_whitespace=False,drop_whitespace=True))
    rows=[]
    for line in result:
        text=html.escape(line).replace(' ','&#160;')
        rows.append([Paragraph(text or '&#160;',S['code'])])
    t=Table(rows,colWidths=[CW],hAlign='LEFT')
    t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),colors.HexColor('#F2F5F7')),('LEFTPADDING',(0,0),(-1,-1),9),('RIGHTPADDING',(0,0),(-1,-1),9),('TOPPADDING',(0,0),(-1,-1),1),('BOTTOMPADDING',(0,0),(-1,-1),1)]))
    t.spaceAfter=8
    return [t]

def markdown_table(lines):
    raw=[]
    for line in lines:
        cells=[x.strip() for x in line.strip().strip('|').split('|')]
        if all(re.fullmatch(r':?-+:?',x) for x in cells):continue
        raw.append(cells)
    n=len(raw[0]);raw=[r+['']*(n-len(r)) for r in raw]
    if n==2:ratios=[.32,.68]
    elif n==3:ratios=[.23,.43,.34]
    elif n==4:ratios=[.08,.22,.43,.27] if raw[0][0]=='ID' else [.19,.24,.31,.26]
    else:ratios=[1/n]*n
    # Long description columns benefit from the majority of width.
    if n==3 and 'mapping' in ' '.join(raw[0]).lower():ratios=[.24,.22,.54]
    if n==3 and raw[0][-1].lower()=='output':ratios=[.25,.55,.20]
    if n==3 and 'required content' in ' '.join(raw[0]).lower():ratios=[.18,.55,.27]
    data=[[p(c,'th' if i==0 else 'table') for c in r] for i,r in enumerate(raw)]
    t=Table(data,colWidths=[CW*r for r in ratios],repeatRows=1,hAlign='LEFT')
    t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),NAVY),('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white,colors.HexColor('#F2F7F8')]),('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),7),('RIGHTPADDING',(0,0),(-1,-1),7),('TOPPADDING',(0,0),(-1,-1),7),('BOTTOMPADDING',(0,0),(-1,-1),7),('LINEBELOW',(0,0),(-1,0),.5,NAVY),('LINEBELOW',(0,-1),(-1,-1),.5,LINE)]))
    return [t,Spacer(1,9)]

def parse_md(filename,part):
    text=(ROOT/filename).read_text(encoding='utf-8')
    lines=text.splitlines();out=[];i=0;diagram_no=0
    while i<len(lines):
        l=lines[i].strip()
        if not l:i+=1;continue
        if l.startswith('# '):i+=1;continue
        if l.startswith('```'):
            lang=l[3:];buf=[];i+=1
            while i<len(lines) and not lines[i].strip().startswith('```'):buf.append(lines[i]);i+=1
            if lang=='mermaid':
                diagram_no+=1
                if part==1:kind='minimal' if diagram_no==1 else 'sequence'
                elif part==2:kind='data'
                else:kind={1:'full',2:'er',3:'sequence'}.get(diagram_no,'full')
                # The full reference sequence uses the same stages but its extended planner is described in prose.
                caption={'minimal':'Figure 1. The agreed minimal architecture: four runtime components and a preparation job.', 'data':'Figure 3. One index, three document types; glossary mappings remain attached to columns.', 'full':'Figure 4. Broader reference architecture. Components and controls are detailed in the following table.', 'er':'Figure 5. Conceptual entities for the broader reference architecture.', 'sequence':'Figure 2. Minimal generation flow and user review.'}[kind]
                if part==3 and kind=='sequence':
                    out.append(Banner('Reference request sequence: identity and scope -> pinned versions -> retrieval -> semantic planning -> local model proposal -> semantic validation -> clarification or SQL compilation -> validation -> review.'))
                    out.append(p('Clarification resumes planning; the detailed sequence is also preserved in the attached source document.','caption'))
                else:out.extend([Diagram(kind),p(caption,'caption')])
            else:out.extend(code_block('\n'.join(buf),lang))
            i+=1;continue
        if l.startswith('### '):out.append(p(l[4:],'h3'));i+=1;continue
        if l.startswith('## '):
            q=heading(l[3:],1)
            q.include_toc=(part!=3)
            out.append(q);i+=1;continue
        if l.startswith('|'):
            buf=[]
            while i<len(lines) and lines[i].strip().startswith('|'):buf.append(lines[i]);i+=1
            out.extend(markdown_table(buf));continue
        if re.match(r'^[-*] ',l):out.append(p('• '+l[2:],'bullet'));i+=1;continue
        if re.match(r'^\d+\. ',l):out.append(p(l,'bullet'));i+=1;continue
        buf=[l];i+=1
        while i<len(lines) and lines[i].strip() and not re.match(r'^(#|\||```|[-*] |\d+\. )',lines[i].strip()):buf.append(lines[i].strip());i+=1
        out.append(p(' '.join(buf)))
    return out

def compact_json(obj,indent=0):
    one=json.dumps(obj,ensure_ascii=False)
    if len(one)+indent<=104 and '\\n' not in one:return ' '*indent+one
    if isinstance(obj,dict):
        rows=[' '*indent+'{']
        for i,(k,v) in enumerate(obj.items()):
            sub=compact_json(v,indent+2).lstrip()
            prefix=' '*(indent+2)+json.dumps(k)+': '
            if '\n' not in sub and len(prefix+sub)<=110:rows.append(prefix+sub+(',' if i<len(obj)-1 else ''))
            elif not isinstance(v,(dict,list)):
                # Keep string exact; display wrapping is applied later.
                rows.append(prefix+json.dumps(v,ensure_ascii=False)+(',' if i<len(obj)-1 else ''))
            else:rows.append(prefix+sub+(',' if i<len(obj)-1 else ''))
        return '\n'.join(rows+[' '*indent+'}'])
    if isinstance(obj,list):
        rows=[' '*indent+'[']
        for i,v in enumerate(obj):rows.append(compact_json(v,indent+2)+(',' if i<len(obj)-1 else ''))
        return '\n'.join(rows+[' '*indent+']'])
    return ' '*indent+one

story=[Cover(),NextPageTemplate('normal'),PageBreak()]
story.append(heading('Reading guide',0,'guide'))
story.append(Banner('Build the minimal solution first. The broader architecture is reference material, not additional POC scope.'))
story.append(Spacer(1,13))
story.append(p('This document consolidates the agreed SQL drafting solution, its Elasticsearch data model, complete mapping and sample metadata. All generation stays on premises; users review and execute SQL through their existing tools.'))
story.extend(markdown_table(['| Part | What it contains |','| 1 - POC / MVP | Components, workflows, algorithms, contracts, deployment and acceptance |','| 2 - Metadata model | Document boundaries, fields, payloads, retrieval and ingestion checks |','| 3 - Reference architecture | The original expanded design, retained for future requirements |','| Appendix A | Complete Elasticsearch index creation body |','| Appendix B | Complete illustrative metadata documents and sample SQL |']))
story.append(p('Configuration notes','h2'))
story.append(p('The DWH engine and A100 memory capacity remain to be confirmed. Oracle SQL and 768 vector dimensions in the sample files are illustrative. Real embeddings must be generated before hybrid-search publication. No live Elasticsearch deployment or DWH validation has been performed.'))
story.append(p('Using this PDF','h2'))
story.append(p('The contents and document outline are clickable. Internal file references jump to the relevant part or appendix. Official documentation links open their source pages. The original Markdown and JSON files are embedded as PDF attachments for exact reuse; long code lines in the printed appendices wrap for readability.'))
story.append(p('Source package','h2'))
for f in ['minimal-logical-architecture.md','elasticsearch-metadata-model.md','logical-architecture.md','elasticsearch-index-mapping.json','elasticsearch-sample-documents.json']:
    story.append(p(f,'small'))
story.append(PageBreak())
story.append(p('Contents','h1'))
toc=TableOfContents();toc.levelStyles=[S['toc0'],S['toc1']];toc.dotsMinLevel=0
story.append(toc)

parts=[('Part 1','The minimal POC / MVP','part1','minimal-logical-architecture.md',1,'AGREED IMPLEMENTATION SCOPE'),('Part 2','Elasticsearch metadata model','part2','elasticsearch-metadata-model.md',2,'ONE INDEX / THREE DOCUMENT TYPES'),('Part 3','Broader architecture reference','part3','logical-architecture.md',3,'REFERENCE ONLY / DEFERRED CAPABILITIES')]
for part,title,key,fn,num,kicker in parts:
    story.append(PageBreak());story.append(p(kicker,'caption'))
    story.append(heading(part+' | '+title,0,key))
    if num==3:story.append(Banner('The following is the original expanded architecture. Its semantic planner, compiler, execution broker and additional services are not required for the agreed minimal POC.',AMBER));story.append(Spacer(1,12))
    story.extend(parse_md(fn,num))

story.append(PageBreak());story.append(heading('Appendix A | Index mapping',0,'appa'))
story.append(p('Complete index creation body. Set the illustrative 768-dimensional vector field to the selected encoder output size before index creation. Check compatibility with the installed Elasticsearch version.'))
mapping=json.loads((ROOT/'elasticsearch-index-mapping.json').read_text(encoding='utf-8'))
story.extend(code_block(compact_json(mapping),'json'))

story.append(PageBreak());story.append(heading('Appendix B | Sample documents',0,'appb'))
story.append(Banner('Fictitious examples for an Oracle 19c target. Vectors are intentionally omitted. The embedded JSON attachment preserves the exact machine-readable document array.'))
story.append(Spacer(1,10))
docs=json.loads((ROOT/'elasticsearch-sample-documents.json').read_text(encoding='utf-8'))
for idx,d in enumerate(docs):
    if idx:story.append(PageBreak())
    story.append(heading(f'B{idx+1}. {d["title"]}',1))
    story.append(p(f'Document type: **{d["document_type"]}**. ID: `{d["document_id"]}`.'))
    if d['document_type']=='example':
        story.append(p('SQL displayed for review','h3'));story.extend(code_block(d['example']['sql'],'sql'))
        story.append(p('Complete document','h3'))
    story.extend(code_block(compact_json(d),'json'))

raw=TMP/'architecture-render.pdf'
Report(raw).multiBuild(story)
reader=PdfReader(str(raw));writer=PdfWriter();writer.clone_document_from_reader(reader)
writer.add_metadata({'/Title':'DWH SQL Assistant - POC / MVP Architecture and Metadata Model','/Author':'Architecture working document','/Subject':'Minimal on-premises SQL drafting solution, Elasticsearch metadata model and implementation reference'})
for fn in ['minimal-logical-architecture.md','elasticsearch-metadata-model.md','logical-architecture.md','elasticsearch-index-mapping.json','elasticsearch-sample-documents.json']:
    writer.add_attachment(fn,(ROOT/fn).read_bytes())
with PDF.open('wb') as f:writer.write(f)
print(json.dumps({'pdf':str(PDF),'pages':len(reader.pages),'bytes':PDF.stat().st_size,'attachments':5}))
