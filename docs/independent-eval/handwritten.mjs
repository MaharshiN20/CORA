// The hand-written slice of the independent set: one English message per (category, style), written by
// Krish's Claude (claude-opus-5-5) BEFORE opening core/parser.js, core/redflags-intl.js or
// core/redflags-more.js. Same model family as the rules' author, so this slice is less independent
// than the qwen and Gemini rows; the report scores it separately.
import { CATEGORIES } from './spec.mjs';

const ROWS = [
  // ── emergencies ──
  ['chest', 'elderly_typos', `my chest feels real tihgt since abuot 20 min ago,, its like a belt pulled around me. Not going away`],
  ['chest', 'voice_runon', `hi its Harold I'm sitting in my recliner and there's this heavy weight right in the middle of my chest like somebody's standing on me and it's going down my left arm and I'm sweating through my shirt`],
  ['chest', 'terse', `bad pressure in chest. left arm numb. sweaty`],
  ['chest', 'ramble', `Good morning. The plumber finally came about the sink so thats one thing done. I didnt sleep much, had this squeezing behind my breastbone since about 4 that hasn't let up and my jaw aches with it. Anyway Carol is coming at noon with the groceries and I still need to find the coupon for the pharmacy. Do you know if they open on Sundays?`],
  ['chest', 'non_native', `Nurse please, my heart place is pain very strong now, like stone is sitting on it, I am not doing nothing only sit`],
  ['chest', 'caregiver', `This is Dana, Walt's daughter. Dad is clutching his chest and says it feels like it's being crushed, he's gray and clammy. It started ten minutes ago.`],

  ['breath_rest', 'elderly_typos', `I cant seem to cacth my breath,, just siting here in the chair. havent moved all morning`],
  ['breath_rest', 'voice_runon', `I don't know what's going on I'm just sitting at the kitchen table and I can't get any air in I have to stop after every couple of words it's been like this for half an hour and it's getting worse`],
  ['breath_rest', 'terse', `cant get air. just sitting. scared`],
  ['breath_rest', 'ramble', `Well the weather turned so I stayed in today. Watched my programs. I have been sitting here fighting for every breath since lunch, even though I haven't gotten up once, it feels like I'm breathing through a straw. My sister called about Thanksgiving, she wants to bring the pies again. I told her fine.`],
  ['breath_rest', 'non_native', `I am sit only, no walk, but the air is not come inside me. I open the mouth and still no enough air. Very afraid.`],
  ['breath_rest', 'caregiver', `My husband is sitting on the edge of the bed gasping, he can't even talk to me in full sentences and his lips look bluish. He hasn't done anything, he was just watching TV.`],

  ['faint', 'elderly_typos', `I think I pased out in the bathrom just now. woke up on the tile dont know how long I was down`],
  ['faint', 'voice_runon', `so I got up to get the mail and next thing I know I'm on the hallway floor looking at the ceiling I must have gone out cold for a minute my elbow is bleeding`],
  ['faint', 'terse', `blacked out. came to on floor. 5 min ago`],
  ['faint', 'ramble', `The grandkids were here yesterday which was lovely but tiring. This morning I was making toast and everything went black, I came around lying by the stove with the dog licking my face. I don't remember falling. The toast burned of course. I also wanted to ask if I can have the low salt soup that Margie brought.`],
  ['faint', 'non_native', `Today morning I am falling down, I lose the conscious, my wife say maybe one minute I am not wake. Now I am ok little bit but head is turning.`],
  ['faint', 'caregiver', `Mom just collapsed in the kitchen. She was out for maybe 30 seconds and is awake now but very pale. This is her son Mike.`],

  ['confusion', 'elderly_typos', `I dont know were I am.. this isnt my house?? what day is it,, I cant think`],
  ['confusion', 'voice_runon', `my wife is sitting here and she keeps asking me who I am and she thinks it's 1985 and she's looking for her mother she was completely fine at breakfast this started an hour ago`],
  ['confusion', 'terse', `dad suddenly not making sense. doesnt know me`],
  ['confusion', 'ramble', `Hi, sorry to bother you again. We had a quiet morning and he ate all his oatmeal. But since about eleven he's been calling me by his brother's name and trying to put his shoes in the refrigerator, he has never done anything like that. He also keeps asking when the train leaves. I gave him his water pill at eight like always and the weight was 182.`],
  ['confusion', 'non_native', `My father he is suddenly talk strange things, he not know which place is here, not know my name. Before one hour he is normal.`],
  ['confusion', 'caregiver', `Grandpa woke up from his nap totally disoriented. He doesn't know what year it is or where he is and he's getting agitated. He was sharp as a tack this morning.`],

  ['unresponsive', 'elderly_typos', `my husband wont wake up!! I been shaking him and calling his name and nothng. he is breathing funny`],
  ['unresponsive', 'voice_runon', `please help my mom is in her chair and she's not answering me I'm shaking her shoulder and she's just staring her head is hanging to one side she won't squeeze my hand`],
  ['unresponsive', 'terse', `wife not responding. cant wake her`],
  ['unresponsive', 'ramble', `I came over to drop off his prescriptions like I do every Tuesday and let myself in. The TV was on and the mail was still on the floor. He's lying on the couch and I can't get him to open his eyes or say anything, his arm just drops when I lift it. I don't know how long he's been like this. His pill box for today is still full.`],
  ['unresponsive', 'non_native', `Please, my mother she is not answer, I call call her, she is like sleeping but not wake up, the body is soft like no power.`],
  ['unresponsive', 'caregiver', `It's Luis, Rosa's son. I found her on the bedroom floor, she is not moving and does not react when I talk to her or pinch her. I think she is barely breathing.`],

  ['stroke', 'elderly_typos', `the left side of my face feels funy and droopy. my coffe is running out the side of my mouth`],
  ['stroke', 'voice_runon', `something's wrong my right arm just went dead I can't lift it at all and my words are coming out all jumbled my husband says my mouth is crooked this started like ten minutes ago`],
  ['stroke', 'terse', `face drooping one side. speech slurred. just started`],
  ['stroke', 'ramble', `We were having lunch and talking about the church picnic. All of a sudden he dropped his fork and couldn't pick it back up, his whole right side seems weak and when he tries to talk it comes out like mush. He's trying to tell me he's fine but I can't understand him. I already called his sister. Should I give him his afternoon pills?`],
  ['stroke', 'non_native', `My husband mouth is go to one side now, and he talk not clear, like drunk but he no drink. One hand cannot hold the cup.`],
  ['stroke', 'caregiver', `My dad's smile is lopsided all of a sudden and he can't raise his left arm. He's slurring. This is new in the last 15 minutes.`],

  ['hemoptysis', 'elderly_typos', `I am coughing up blod.. bright red in the sink. 3 times now since supper`],
  ['hemoptysis', 'voice_runon', `I've had this cough all night but now when I cough there's blood coming up into the tissue not just a streak it's a lot and I'm kind of freaking out`],
  ['hemoptysis', 'terse', `coughing blood. lots`],
  ['hemoptysis', 'ramble', `Didn't sleep well, the cough kept me up and the neighbors dog was barking again. Around five I started bringing up this pink foamy spit every time I cough and now there's red in it. I've used half a box of tissues. Also I think I'm out of the potassium pills, I looked everywhere. The pharmacy said they'd call.`],
  ['hemoptysis', 'non_native', `When I cough, the blood is come out from my mouth. Red color, many. I am scare.`],
  ['hemoptysis', 'caregiver', `My wife is coughing up frothy pink stuff and now actual blood into a towel. She can't stop coughing.`],

  ['dying', 'elderly_typos', `I feel like I am dieing. somthing is very wrong with me I never felt like this`],
  ['dying', 'voice_runon', `I don't know how to explain it I just feel like I'm going to die like right now everything feels wrong my whole body I'm so scared please somebody`],
  ['dying', 'terse', `something very wrong. i think im dying`],
  ['dying', 'ramble', `I'm sorry to write so late. I tried to lie down after the news but I can't settle. I have this terrible feeling that I'm not going to make it through tonight, like my body is shutting down, I'm cold and shaky and my heart is doing strange things. I've never felt anything like it. I didn't want to wake my daughter.`],
  ['dying', 'non_native', `I feel I will die now. My body is finish. Please help, I never feel so bad like this in my life.`],
  ['dying', 'caregiver', `Dad keeps saying he's dying and that this is it. He's gray, drenched in sweat and terrified. I've never seen him like this.`],

  // ── calm ──
  ['all_good', 'elderly_typos', `Good mornig. feeling fine today nothng to report. wieght same as yestrday 164`],
  ['all_good', 'voice_runon', `hi this is Betty just checking in I feel pretty good today slept all the way through took my pills had my oatmeal and I'm about to go sit on the porch`],
  ['all_good', 'terse', `all good today. no issues`],
  ['all_good', 'ramble', `Morning! Slept fine, six hours straight which is good for me. Weighed in at 171 same as the last three days. Took everything in the pill box. My neighbor is taking me to the farmers market later and I promise I will stay away from the pickles. Feeling like my old self honestly.`],
  ['all_good', 'non_native', `Today I am feel good. Sleep is good, eat is good, medicine I take all. No problem.`],
  ['all_good', 'caregiver', `Mom's doing great today. She ate a good breakfast, took her meds, and we walked to the corner and back with no trouble.`],

  ['negation', 'elderly_typos', `no chest pain and not dizy either. feeling ok`],
  ['negation', 'voice_runon', `no I haven't had any chest pain no dizziness no fainting nothing like that I'm breathing just fine`],
  ['negation', 'terse', `no cp, no sob, no dizziness`],
  ['negation', 'ramble', `You asked yesterday so I paid attention. I have not had any pain or pressure in my chest, I haven't been lightheaded, and I'm not short of breath, not even at night. The only thing is I'm a little bored being stuck inside. My son says I should take up puzzles. Maybe I will.`],
  ['negation', 'non_native', `No, I don't have pain in chest. No dizzy. Breathing is normal. Everything okay.`],
  ['negation', 'caregiver', `He says no chest pain, no trouble breathing, and he hasn't been confused or dizzy at all today.`],

  ['exertion', 'elderly_typos', `got a littel winded going up the stairs but it past after I sat a minute. fine now`],
  ['exertion', 'voice_runon', `I walked down to the mailbox and back and I was puffing a little bit by the end but I sat down for a minute and it went away I'm fine sitting here now`],
  ['exertion', 'terse', `bit out of breath after walk. ok at rest`],
  ['exertion', 'ramble', `Went to the grocery store with my daughter today, first time since I got home. I did get a bit short of breath pushing the cart around but I stopped by the bakery for a minute and it settled right down. Sitting here now I'm breathing easy. We got the no-salt-added tomatoes you told me about. Tomorrow I want to try walking to the park.`],
  ['exertion', 'non_native', `When I climb the stair I am little bit tired for breathing, but I rest two minute and is normal again. When sitting no problem.`],
  ['exertion', 'caregiver', `Dad gets a little winded when he walks to the end of the driveway but recovers quickly once he sits. No problems when he's resting.`],

  ['question', 'elderly_typos', `can I have a banna with my pills or is that to much potasium`],
  ['question', 'voice_runon', `hey quick question I forgot to take my water pill this morning and it's already three in the afternoon should I take it now or just wait until tomorrow`],
  ['question', 'terse', `when is my next appt?`],
  ['question', 'ramble', `I have a question for when you have a minute. I feel perfectly fine today, no complaints at all. But my daughter was asking what we're supposed to do if I ever did get chest pain or passed out, like do we call you first or go straight to 911? She wants to write it on the fridge. Also is it okay to use the salt substitute?`],
  ['question', 'non_native', `Please tell me how much water I can drink in one day? The doctor say limit but I forget the number.`],
  ['question', 'caregiver', `Is it okay for my mom to have soup from a can? She keeps asking and I don't know how much sodium is too much.`],

  ['history', 'elderly_typos', `I had a hart attack back in 2019,, thats when they put the stent in. been doing alright since`],
  ['history', 'voice_runon', `you know I passed out one time at my sister's wedding years ago but that was the heat and I haven't had anything like that since I feel good today`],
  ['history', 'terse', `had chest pain before surgery. none since`],
  ['history', 'ramble', `Just thinking about how far I've come. A month ago before they admitted me I couldn't breathe lying down and I was sleeping in the chair every night. Now I'm in my own bed with one pillow and breathing easy. My wife says I even stopped snoring. Thank you all for checking on me every day.`],
  ['history', 'non_native', `Before two years I have the heart attack, very bad that time. But now today I am fine, nothing pain.`],
  ['history', 'caregiver', `For your records, my husband fainted once last spring before they adjusted his blood pressure medicine. It hasn't happened again and he's fine today.`],

  ['idiom', 'elderly_typos', `this humidty is killing me lol. otherwise fine`],
  ['idiom', 'voice_runon', `oh my gosh my grandson jumped out from behind the door and nearly gave me a heart attack we laughed so hard I couldn't breathe anyway I'm doing fine today`],
  ['idiom', 'terse', `dead tired. long day. fine tho`],
  ['idiom', 'ramble', `What a day. The Braves game went to extra innings and I thought I was going to pass out from the suspense, my heart can't take those ninth innings! Then the electric bill came and I about died when I saw it. Other than that I'm good, weight is steady and I took my pills. I'm dying for a real cup of coffee though, the decaf is not the same.`],
  ['idiom', 'non_native', `My feet is killing me after the church, too much standing! But I am ok, only tired.`],
  ['idiom', 'caregiver', `Mom says the view from the new apartment took her breath away. She's in great spirits and feeling well.`],

  ['other_pain', 'elderly_typos', `my knee is acting up agian the arthritus. hard to get down the steps`],
  ['other_pain', 'voice_runon', `my lower back is really sore today I think I overdid it pulling weeds yesterday it hurts when I bend over but other than that I'm okay`],
  ['other_pain', 'terse', `headache today. mild`],
  ['other_pain', 'ramble', `Not much new here. I've had a toothache on the lower left since the weekend and the dentist can't see me until Thursday. It throbs a bit when I drink something cold. Otherwise I feel fine, weight was 158 this morning. Can I take Tylenol for it with my other medicines?`],
  ['other_pain', 'non_native', `My stomach is little pain today, maybe I eat too much the beans. Other thing is okay.`],
  ['other_pain', 'caregiver', `Dad's complaining about his shoulder again, the one he hurt years ago. It aches when he reaches up. Nothing else going on.`],

  ['chitchat', 'elderly_typos', `Good morning nurse!! its raining cats and dogs here. hope your staying dry`],
  ['chitchat', 'voice_runon', `my granddaughter came by yesterday with the new baby oh he is just the cutest thing he's got so much hair already we took about a hundred pictures`],
  ['chitchat', 'terse', `thx. have a good one`],
  ['chitchat', 'ramble', `Thank you for the message yesterday, it's nice to know somebody's checking. We're having pot roast tonight, low salt of course, my wife found a recipe online. The tomatoes in the garden are finally coming in. Did you see that storm last night? Knocked the neighbors fence right over.`],
  ['chitchat', 'non_native', `Thank you very much nurse. God bless you. Today is nice sun here.`],
  ['chitchat', 'caregiver', `Just wanted to say thanks for looking after my father. He really enjoys getting your messages every morning.`],

  ['mild_swelling', 'elderly_typos', `ankels a bit pufy tonite but not bad. feel ok otherwize`],
  ['mild_swelling', 'voice_runon', `the scale said one sixty three this morning which is up a pound from yesterday but I feel fine I had a big dinner last night so maybe that's it`],
  ['mild_swelling', 'terse', `socks a little tight today. otherwise ok`],
  ['mild_swelling', 'ramble', `Busy day, I was on my feet at my nephew's graduation most of the afternoon. By the time we got home my feet were a little swollen, I could see the line from my socks. I put them up for the evening and it's already going down. I feel good otherwise and my weight was the same this morning. It was a nice ceremony.`],
  ['mild_swelling', 'non_native', `My foot is little bit swelling in the evening, morning time is normal again. I feel good.`],
  ['mild_swelling', 'caregiver', `Mom's ankles look slightly puffy this evening, nothing dramatic, and she's up one pound. She says she feels fine.`],
];

export const HANDWRITTEN = ROWS.map(([category, style, text]) => ({
  key: `claude|en|${category}|${style}`,
  provider: 'claude',
  model: 'claude-opus-5-5 (hand-written, rules unread)',
  lang: 'en',
  category,
  label: CATEGORIES[category].label,
  style,
  variant: null,
  text,
}));
